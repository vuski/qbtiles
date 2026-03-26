"""
Comprehensive Python API tests for qbtiles.
Results saved to tests/results/.

Usage:
  $env:PROJ_DATA="z:\Github\qbtiles\.venv\Lib\site-packages\rasterio\proj_data"; python tests/test_api.py
"""
import sys, os, struct, gzip, warnings, time
from io import BytesIO
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src', 'python'))
import qbtiles as qbt

RESULTS = os.path.join(os.path.dirname(__file__), 'results')
os.makedirs(RESULTS, exist_ok=True)

passed = 0
failed = 0

def test(name, func):
    global passed, failed
    print(f"  {name}...", end=" ", flush=True)
    try:
        func()
        print("OK")
        passed += 1
    except Exception as e:
        print(f"FAIL: {e}")
        failed += 1

# Setup: unzip test tiles
import zipfile
tiles_dir = os.path.join(RESULTS, '_tiles')
zip_path = os.path.join(os.path.dirname(__file__), '..', 'docs', 'examples', 'tiles.zip')
if os.path.exists(zip_path) and not os.path.exists(tiles_dir):
    with zipfile.ZipFile(zip_path, 'r') as zf:
        zf.extractall(tiles_dir)

HAS_TILES = os.path.exists(tiles_dir)

try:
    import rasterio, numpy as np
    from rasterio.transform import from_bounds
    HAS_RASTERIO = True
except ImportError:
    HAS_RASTERIO = False

# ============================================================
print("=" * 60)
print("1. build() - Variable-entry (tile archive)")
print("=" * 60)

if HAS_TILES:
    def t():
        out = os.path.join(RESULTS, 'var_basic.qbt')
        qbt.build(out, folder=tiles_dir)
        h = qbt.read_qbt_header(out)
        assert h['flags'] == 0x0
        assert h['values_length'] > 0, "data not embedded"
        assert h['values_offset'] > 128
    test("build(folder) -> single .qbt with data", t)

    def t():
        out = os.path.join(RESULTS, 'var_ext.qbt')
        qbt.build(out, folder=tiles_dir, ext=".png")
        h = qbt.read_qbt_header(out)
        assert h['values_length'] > 0
    test("build(folder, ext='.png')", t)

    def t():
        out = os.path.join(RESULTS, 'var_basic.qbt')
        h = qbt.read_qbt_header(out)
        with open(out, 'rb') as f: raw = f.read()
        idx_bytes = gzip.decompress(raw[h['header_size']:h['header_size'] + h['bitmask_length']])
        entries = qbt.deserialize_quadtree_index(idx_bytes)
        index = {e['quadkey_int']: e for e in entries}
        qk = qbt.tile_to_quadkey_int64(3, 4, 2)
        entry = index[qk]
        tile = raw[h['values_offset'] + entry['offset']:h['values_offset'] + entry['offset'] + entry['length']]
        with open(os.path.join(tiles_dir, '3', '4', '2.png'), 'rb') as f: orig = f.read()
        assert tile == orig, "tile data mismatch"
    test("tile data preserved in .qbt", t)

    def t():
        try:
            qbt.build(os.path.join(RESULTS, '_bad.qbt'), folder=os.path.join(RESULTS, '_nonexistent'))
            assert False
        except ValueError as e:
            assert "No tiles" in str(e)
    test("build(folder=empty) -> ValueError", t)
else:
    print("  SKIP: tiles.zip not found")

# ============================================================
print()
print("=" * 60)
print("2. build() - Columnar")
print("=" * 60)

def t():
    out = os.path.join(RESULTS, 'col_basic.qbt.gz')
    qbt.build(out, coords=[(700050,1300050),(700150,1300050),(700050,1300150),(700150,1300150)],
        columns={"pop":[10,20,30,40],"male":[5,10,15,20]}, cell_size=100, crs=5179)
    h = qbt.read_qbt_header(out)
    assert h['is_columnar']
    assert h['crs'] == 5179
    assert len(h['fields']) == 2
    assert h['fields'][0]['name'] == 'pop'
test("build(coords, columns, cell_size, crs)", t)

def t():
    out = os.path.join(RESULTS, 'col_auto.qbt.gz')
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        qbt.build(out, coords=[(700050,1300050),(750000,1350000)], columns={"v":[1,2]}, cell_size=100, crs=5179)
    assert any("snapped" in str(x.message) for x in w)
    h = qbt.read_qbt_header(out)
    assert h['origin_x'] != -180.0
test("auto origin/extent from coords", t)

def t():
    out = os.path.join(RESULTS, 'col_dup.qbt.gz')
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        qbt.build(out, coords=[(700050,1300050),(700060,1300060),(700150,1300050)],
            columns={"pop":[10,20,30]}, cell_size=100, crs=5179)
    assert any("multiple points" in str(x.message) for x in w)
test("duplicate coords -> sum warning", t)

def t():
    try:
        qbt.build(os.path.join(RESULTS,'_bad.qbt.gz'), coords=[(0,0)], columns={"c":["A"]}, cell_size=1, crs=5179)
        assert False
    except ValueError as e:
        assert "non-numeric" in str(e)
test("non-numeric column -> ValueError", t)

def t():
    out = os.path.join(RESULTS, 'col_types.qbt.gz')
    qbt.build(out, coords=[(700050,1300050),(700150,1300050)],
        columns={"count":[10,20],"ratio":[1.5,2.5]}, cell_size=100, crs=5179)
    h = qbt.read_qbt_header(out)
    types = {f['name']:f['type'] for f in h['fields']}
    assert types['count'] == qbt.TYPE_VARINT
    assert types['ratio'] == qbt.TYPE_FLOAT32
test("type auto-detect (int->varint, float->float32)", t)

def t():
    out = os.path.join(RESULTS, 'col_roundtrip.qbt.gz')
    coords = [(700050+i*100,1300050+j*100) for i in range(5) for j in range(5)]
    vals = list(range(25))
    qbt.build(out, coords=coords, columns={"v":vals}, cell_size=100, crs=5179)
    h = qbt.read_qbt_header(out)
    raw = gzip.decompress(open(out,'rb').read())
    bio = BytesIO(raw[h['values_offset']:])
    read_vals = [qbt.read_varint(bio) for _ in range(25)]
    assert sorted(read_vals) == sorted(vals), f"roundtrip mismatch"
test("columnar value roundtrip", t)

# ============================================================
print()
print("=" * 60)
print("3. build() - Fixed row")
print("=" * 60)

def t():
    out = os.path.join(RESULTS, 'fix_basic.qbt')
    qbt.build(out, coords=[(700050,1300050),(700150,1300150),(750000,1350000)],
        values=[100.0,200.0,300.0], cell_size=100, crs=5179, entry_size=4,
        fields=[{"type":qbt.TYPE_FLOAT32,"name":"pop"}])
    h = qbt.read_qbt_header(out)
    assert h['is_fixed'] and not h['is_columnar']
    assert h['entry_size'] == 4
    assert h['values_length'] == 12
test("build(coords, values, cell_size)", t)

def t():
    out = os.path.join(RESULTS, 'fix_basic.qbt')
    h = qbt.read_qbt_header(out)
    with open(out,'rb') as f: f.seek(h['values_offset']); data = f.read(h['values_length'])
    vals = [struct.unpack_from('<f',data,i*4)[0] for i in range(3)]
    assert set(vals) == {100.0,200.0,300.0}
test("read fixed values back", t)

def t():
    out = os.path.join(RESULTS, 'fix_cs.qbt')
    qbt.build(out, coords=[(700050,1300050)], values=[1.0], cell_size=100, crs=5179,
        entry_size=4, fields=[{"type":qbt.TYPE_FLOAT32,"name":"v"}])
    h = qbt.read_qbt_header(out)
    assert abs(h['extent_x']/(2**h['zoom']) - 100.0) < 0.01
test("cell_size -> zoom auto", t)

def t():
    try:
        qbt.build(os.path.join(RESULTS,'_bad.qbt'), coords=[(0,0)], values=[1.0],
            cell_size=100, zoom=10, crs=5179, entry_size=4,
            fields=[{"type":qbt.TYPE_FLOAT32,"name":"v"}])
        assert False
    except ValueError as e:
        assert "either zoom or cell_size" in str(e).lower() or "not both" in str(e).lower()
test("cell_size + zoom -> ValueError", t)

def t():
    try:
        qbt.build(os.path.join(RESULTS,'_bad.qbt'))
        assert False
    except ValueError as e:
        assert "folder" in str(e).lower() or "coords" in str(e).lower() or "required" in str(e).lower()
test("no args -> ValueError", t)

# ============================================================
print()
print("=" * 60)
print("4. build() - GeoTIFF conversion")
print("=" * 60)

if HAS_RASTERIO:
    def t():
        tif = os.path.join(RESULTS, 'geo_single.tif')
        data = np.full((10,10), -9999.0, dtype=np.float32)
        data[2,3]=100.0; data[5,7]=200.0; data[8,1]=300.0
        tf = from_bounds(126,35,127,36,10,10)
        with rasterio.open(tif,'w',driver='GTiff',height=10,width=10,count=1,
                dtype='float32',crs='EPSG:4326',transform=tf,nodata=-9999.0) as d:
            d.write(data,1)
        out = os.path.join(RESULTS, 'geo_single.qbt')
        qbt.build(out, geotiff=tif)
        h = qbt.read_qbt_header(out)
        assert h['is_fixed'] and not h['is_columnar']
        assert h['values_length'] == 12
        assert abs(h['extent_x']/(2**h['zoom']) - 0.1) < 1e-10
    test("single-band GeoTIFF -> fixed row", t)

    def t():
        tif = os.path.join(RESULTS, 'geo_multi.tif')
        b1 = np.full((5,5),-9999.0,dtype=np.float32); b2 = b1.copy()
        b1[1,2]=10.0; b1[3,4]=20.0; b2[1,2]=100.0; b2[3,4]=200.0
        tf = from_bounds(126,35,127,36,5,5)
        with rasterio.open(tif,'w',driver='GTiff',height=5,width=5,count=2,
                dtype='float32',crs='EPSG:4326',transform=tf,nodata=-9999.0) as d:
            d.write(b1,1); d.write(b2,2)
        out = os.path.join(RESULTS, 'geo_multi.qbt.gz')
        qbt.build(out, geotiff=tif)
        h = qbt.read_qbt_header(out)
        assert h['is_columnar']
        assert len(h['fields']) == 2
    test("multi-band GeoTIFF -> columnar", t)

    def t():
        tif = os.path.join(RESULTS, 'geo_nodata.tif')
        data = np.full((10,10),-9999.0,dtype=np.float32); data[0,0]=42.0
        tf = from_bounds(0,0,1,1,10,10)
        with rasterio.open(tif,'w',driver='GTiff',height=10,width=10,count=1,
                dtype='float32',crs='EPSG:4326',transform=tf,nodata=-9999.0) as d:
            d.write(data,1)
        out = os.path.join(RESULTS, 'geo_nodata.qbt')
        qbt.build(out, geotiff=tif)
        h = qbt.read_qbt_header(out)
        assert h['values_length'] == 4
    test("nodata excluded (1 valid cell)", t)

    def t():
        tif = os.path.join(RESULTS, 'geo_int.tif')
        data = np.full((5,5),-9999,dtype=np.int32); data[1,1]=42; data[3,3]=99
        tf = from_bounds(126,35,127,36,5,5)
        with rasterio.open(tif,'w',driver='GTiff',height=5,width=5,count=1,
                dtype='int32',crs='EPSG:4326',transform=tf,nodata=-9999) as d:
            d.write(data,1)
        out = os.path.join(RESULTS, 'geo_int.qbt')
        qbt.build(out, geotiff=tif)
        h = qbt.read_qbt_header(out)
        assert h['fields'][0]['type'] == qbt.TYPE_INT32
    test("int32 GeoTIFF -> TYPE_INT32", t)
else:
    print("  SKIP: rasterio not installed")

# ============================================================
print()
print("=" * 60)
print("5. build() - quadkeys input")
print("=" * 60)

def t():
    out = os.path.join(RESULTS, 'qk_col.qbt.gz')
    qk1 = qbt.encode_custom_quadkey(700050,1300050,13,700000,1300000,819200)
    qk2 = qbt.encode_custom_quadkey(700150,1300150,13,700000,1300000,819200)
    qbt.build(out, quadkeys=[qk1,qk2], columns={"v":[1,2]},
        zoom=13, crs=5179, origin_x=700000, origin_y=1300000, extent_x=819200, extent_y=819200)
    h = qbt.read_qbt_header(out)
    assert h['is_columnar'] and h['zoom'] == 13
test("build(quadkeys, columns)", t)

def t():
    out = os.path.join(RESULTS, 'qk_fix.qbt')
    qk1 = qbt.encode_custom_quadkey(700050,1300050,13,700000,1300000,819200)
    qbt.build(out, quadkeys=[qk1], values=[42.0],
        zoom=13, crs=5179, origin_x=700000, origin_y=1300000, extent_x=819200, extent_y=819200,
        entry_size=4, fields=[{"type":qbt.TYPE_FLOAT32,"name":"v"}])
    h = qbt.read_qbt_header(out)
    assert h['is_fixed'] and not h['is_columnar']
test("build(quadkeys, values)", t)

# ============================================================
print()
print("=" * 60)
print("6. read_qbt_header()")
print("=" * 60)

def t():
    h = qbt.read_qbt_header(os.path.join(RESULTS, 'fix_basic.qbt'))
    assert h['magic'] == b'QBT\x01'
    assert h['version'] == 1
    assert h['header_size'] >= 128
    for k in ['zoom','crs','origin_x','origin_y','extent_x','extent_y','bitmask_length',
              'values_offset','values_length','entry_size','field_count','index_hash','fields']:
        assert k in h, f"missing key: {k}"
test("read_qbt_header(filepath) - all keys", t)

def t():
    with open(os.path.join(RESULTS, 'fix_basic.qbt'),'rb') as f: raw = f.read()
    h = qbt.read_qbt_header(raw)
    assert h['magic'] == b'QBT\x01'
test("read_qbt_header(bytes)", t)

def t():
    h = qbt.read_qbt_header(os.path.join(RESULTS, 'col_basic.qbt.gz'))
    assert h['is_columnar']
test("read_qbt_header(gzip file)", t)

# ============================================================
print()
print("=" * 60)
print("7. Quadkey conversion")
print("=" * 60)

def t():
    for z,x,y in [(0,0,0),(3,4,2),(14,13500,6200)]:
        qk = qbt.tile_to_quadkey_int64(z,x,y)
        z2,x2,y2 = qbt.quadkey_int64_to_zxy(qk)
        assert (z,x,y)==(z2,x2,y2)
test("tile_to_quadkey_int64 <-> quadkey_int64_to_zxy", t)

def t():
    for z,x,y in [(0,0,0),(3,4,2),(5,17,11)]:
        qk = qbt.tile_to_quadkey(z,x,y)
        z2,x2,y2 = qbt.quadkey_to_zxy(qk)
        assert (z,x,y)==(z2,x2,y2)
test("tile_to_quadkey <-> quadkey_to_zxy (string)", t)

def t():
    qk_int = qbt.tile_to_quadkey_int64(5,17,11)
    qk_str = qbt.quadkey_int64_to_str(qk_int)
    qk_int2 = qbt.quadkey_str_to_int64(qk_str)
    assert qk_int == qk_int2
test("quadkey_int64_to_str <-> quadkey_str_to_int64", t)

def t():
    x,y,zoom = 750000,1350000,13
    ox,oy,ext = 700000,1300000,819200
    qk = qbt.encode_custom_quadkey(x,y,zoom,ox,oy,ext)
    x2,y2 = qbt.decode_custom_quadkey(qk,zoom,ox,oy,ext)
    assert x2==x and y2==y
test("encode_custom_quadkey <-> decode_custom_quadkey", t)

def t():
    try:
        qbt.encode_custom_quadkey(-1, -1, 13, 700000, 1300000, 819200)
        assert False
    except ValueError:
        pass
test("encode_custom_quadkey out of bounds -> ValueError", t)

# ============================================================
print()
print("=" * 60)
print("8. Low-level writers")
print("=" * 60)

def t():
    entries = [(qbt.tile_to_quadkey_int64(3,x,y),"",0,100,1) for x in range(4) for y in range(4)]
    root = qbt.build_quadtree(entries)
    bm, lc = qbt.serialize_bitmask(root)
    assert isinstance(bm, bytes) and lc == 16
test("serialize_bitmask", t)

def t():
    entries = [(qbt.tile_to_quadkey_int64(2,x,y),"",x*100,100,1) for x in range(4) for y in range(4)]
    root = qbt.build_quadtree(entries)
    out = os.path.join(RESULTS, 'lowlevel_var.qbt')
    qbt.write_qbt_variable(out, root, zoom=2)
    h = qbt.read_qbt_header(out)
    assert h['flags'] == 0x0
test("write_qbt_variable", t)

def t():
    entries = [(qbt.tile_to_quadkey_int64(2,x,y),"",0,0,1) for x in range(4) for y in range(4)]
    root = qbt.build_quadtree(entries)
    bm, lc = qbt.serialize_bitmask(root)
    values = struct.pack('<' + 'f'*lc, *[float(i) for i in range(lc)])
    out = os.path.join(RESULTS, 'lowlevel_fix.qbt')
    qbt.write_qbt_fixed(out, bm, values, zoom=2, entry_size=4,
        fields=[{"type":qbt.TYPE_FLOAT32,"offset":0,"name":"v"}])
    h = qbt.read_qbt_header(out)
    assert h['is_fixed'] and h['values_length'] == lc * 4
test("write_qbt_fixed", t)

def t():
    entries = [(qbt.tile_to_quadkey_int64(2,x,y),"",0,0,1) for x in range(4) for y in range(4)]
    root = qbt.build_quadtree(entries)
    bm, lc = qbt.serialize_bitmask(root)
    out = os.path.join(RESULTS, 'lowlevel_col.qbt.gz')
    qbt.write_qbt_columnar(out, bm, [(qbt.TYPE_VARINT, list(range(lc)))], lc,
        zoom=2, fields=[{"type":qbt.TYPE_VARINT,"offset":0,"name":"v"}])
    h = qbt.read_qbt_header(out)
    assert h['is_columnar']
test("write_qbt_columnar", t)

def t():
    if HAS_TILES:
        entries = qbt.index_tile_folder(tiles_dir)
        assert len(entries) > 0
        qks = [e[0] for e in entries]
        assert qks == sorted(qks)
    else:
        raise Exception("tiles_dir not found")
test("index_tile_folder", t)

def t():
    entries = [(qbt.tile_to_quadkey_int64(2,x,y),"",x*100,100,1) for x in range(4) for y in range(4)]
    root = qbt.build_quadtree(entries)
    out = os.path.join(RESULTS, '_temp_idx.gz')
    qbt.write_tree_bitmask_to_single_file(root, out)
    with gzip.open(out,'rb') as f: raw = f.read()
    result = qbt.deserialize_quadtree_index(raw)
    assert len(result) == 16
    os.remove(out)
test("deserialize_quadtree_index(bytes)", t)

def t():
    bio = BytesIO()
    qbt.write_varint(bio, 300)
    bio.seek(0)
    assert qbt.read_varint(bio) == 300
test("write_varint / read_varint", t)

# ============================================================
print()
print("=" * 60)
print("9. Type constants")
print("=" * 60)

def t():
    assert qbt.TYPE_UINT8 == 1
    assert qbt.TYPE_INT16 == 2
    assert qbt.TYPE_UINT16 == 3
    assert qbt.TYPE_INT32 == 4
    assert qbt.TYPE_UINT32 == 5
    assert qbt.TYPE_FLOAT32 == 6
    assert qbt.TYPE_FLOAT64 == 7
    assert qbt.TYPE_INT64 == 8
    assert qbt.TYPE_UINT64 == 9
    assert qbt.TYPE_VARINT == 10
test("all type constants", t)

# ============================================================
print()
print("=" * 60)
total = passed + failed
print(f"Python: {passed}/{total} passed, {failed} failed")
print(f"Results in: {RESULTS}")
print("=" * 60)

if failed > 0:
    sys.exit(1)
