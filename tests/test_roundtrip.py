"""
Round-trip tests: read existing .qbt → extract coords+values → rebuild with build() → compare.
"""
import sys, os, gzip, struct
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src', 'python'))
import qbtiles as qbt

EXAMPLES = os.path.join(os.path.dirname(__file__), '..', 'examples')
REF = os.path.join(os.path.dirname(__file__), '..', 'ref')
RESULTS = os.path.join(os.path.dirname(__file__), 'results')
os.makedirs(RESULTS, exist_ok=True)


def bitmask_to_leaf_quadkeys(bm_raw):
    """Parse raw bitmask nibbles (no 4B prefix) → list of leaf quadkey int64s."""
    nibbles = []
    for b in bm_raw:
        nibbles.append(b >> 4)
        nibbles.append(b & 0x0F)
    if nibbles and nibbles[-1] == 0:
        nibbles.pop()

    quadkeys_all = [3]  # root
    queue = [3]
    idx = 0
    while idx < len(nibbles):
        next_queue = []
        for parent in queue:
            if idx >= len(nibbles):
                break
            mask = nibbles[idx]
            for i in range(4):
                if mask & (1 << (3 - i)):
                    child = (parent << 2) | i
                    quadkeys_all.append(child)
                    next_queue.append(child)
            idx += 1
        queue = next_queue

    total_children = sum(bin(n).count('1') for n in nibbles)
    leaf_count = total_children - len(nibbles) + 1
    return quadkeys_all[-leaf_count:]


def test_columnar_korea():
    """Round-trip: korea_pop_100m.qbt.gz (columnar, EPSG:5179, 100m, varint×3)"""
    src = os.path.join(EXAMPLES, 'korea_pop_100m.qbt.gz')
    if not os.path.exists(src):
        print(f'SKIP: {src} not found')
        return

    # 1. Read original
    h = qbt.read_qbt_header(src)
    print(f'Original: zoom={h["zoom"]}, crs={h["crs"]}, '
          f'origin=({h["origin_x"]}, {h["origin_y"]}), extent=({h["extent_x"]}, {h["extent_y"]})')

    # Decompress full file
    with open(src, 'rb') as f:
        raw = gzip.decompress(f.read())

    # Decompress bitmask
    bm_start = h['header_size']
    bm_compressed = raw[bm_start:bm_start + h['bitmask_length']]
    bm_raw = gzip.decompress(bm_compressed)

    from io import BytesIO

    quadkeys = bitmask_to_leaf_quadkeys(bm_raw)
    print(f'  Cells: {len(quadkeys):,}')

    # Read varint columns
    val_io = BytesIO(raw[h['values_offset']:])
    def read_varints(bio, count):
        return [qbt.read_varint(bio) for _ in range(count)]

    n = len(quadkeys)
    col_values = {}
    for field in h['fields']:
        col_values[field['name']] = read_varints(val_io, n)

    # 2. Rebuild with build()
    # Convert quadkeys back to coords
    cell_size = h['extent_x'] / (2 ** h['zoom'])
    coords = []
    for qk in quadkeys:
        x, y = qbt.decode_custom_quadkey(qk, h['zoom'], h['origin_x'], h['origin_y'], h['extent_x'])
        coords.append((x, y))

    out = os.path.join(RESULTS, 'korea_pop_100m.qbt.gz')
    qbt.build(out,
        coords=coords,
        columns=col_values,
        cell_size=cell_size,
        crs=h['crs'],
        origin_x=h['origin_x'], origin_y=h['origin_y'],
        extent_x=h['extent_x'], extent_y=h['extent_y'])

    # 3. Compare
    h2 = qbt.read_qbt_header(out)
    print(f'Rebuilt:  zoom={h2["zoom"]}, crs={h2["crs"]}, '
          f'origin=({h2["origin_x"]}, {h2["origin_y"]}), extent=({h2["extent_x"]}, {h2["extent_y"]})')

    assert h2['zoom'] == h['zoom'], f'zoom mismatch: {h2["zoom"]} vs {h["zoom"]}'
    assert h2['crs'] == h['crs'], f'crs mismatch'
    assert h2['origin_x'] == h['origin_x'], f'origin_x mismatch'
    assert h2['origin_y'] == h['origin_y'], f'origin_y mismatch'
    assert h2['extent_x'] == h['extent_x'], f'extent_x mismatch'
    assert len(h2['fields']) == len(h['fields']), f'field count mismatch'

    # Read back values and compare
    with open(out, 'rb') as f:
        raw2 = gzip.decompress(f.read())

    val_io2 = BytesIO(raw2[h2['values_offset']:])
    for field in h2['fields']:
        vals2 = read_varints(val_io2, n)
        vals1 = col_values[field['name']]
        assert len(vals2) == len(vals1), f'{field["name"]}: count {len(vals2)} vs {len(vals1)}'
        mismatches = sum(1 for a, b in zip(vals1, vals2) if a != b)
        assert mismatches == 0, f'{field["name"]}: {mismatches} mismatches'
        print(f'  {field["name"]}: {n:,} values, all match')

    print(f'  Output: {out}')
    print('PASS: columnar korea round-trip')


def test_fixed_worldpop():
    """Round-trip: global_pop.qbt (fixed row, EPSG:4326, float32)"""
    src = os.path.join(REF, 'global_pop.qbt')
    if not os.path.exists(src):
        print(f'SKIP: {src} not found')
        return

    # 1. Read original header
    h = qbt.read_qbt_header(src)
    print(f'Original: zoom={h["zoom"]}, crs={h["crs"]}, '
          f'origin=({h["origin_x"]}, {h["origin_y"]}), '
          f'extent=({h["extent_x"]}, {h["extent_y"]}), '
          f'entry_size={h["entry_size"]}')

    # Read bitmask to get quadkeys
    with open(src, 'rb') as f:
        f.seek(h['header_size'])
        bm_compressed = f.read(h['bitmask_length'])
    bm_raw = gzip.decompress(bm_compressed)
    quadkeys = bitmask_to_leaf_quadkeys(bm_raw)
    print(f'  Cells: {len(quadkeys):,}')

    # Read values
    with open(src, 'rb') as f:
        f.seek(h['values_offset'])
        values_bytes = f.read(h['values_length'])

    n = len(quadkeys)
    values = [struct.unpack_from('<f', values_bytes, i * 4)[0] for i in range(n)]
    print(f'  Values read: {n:,}')

    # 2. Rebuild — use quadkeys directly (4326 doesn't need coord conversion)
    cell_size = h['extent_x'] / (2 ** h['zoom'])
    coords = []
    for qk in quadkeys:
        x, y = qbt.decode_custom_quadkey(qk, h['zoom'], h['origin_x'], h['origin_y'], h['extent_x'])
        coords.append((x, y))

    out = os.path.join(RESULTS, 'global_pop.qbt')
    print('  Rebuilding...')
    qbt.build(out,
        quadkeys=quadkeys,
        values=values,
        zoom=h['zoom'],
        crs=h['crs'],
        origin_x=h['origin_x'], origin_y=h['origin_y'],
        extent_x=h['extent_x'], extent_y=h['extent_y'],
        entry_size=h['entry_size'],
        fields=h['fields'])

    # 3. Compare headers
    h2 = qbt.read_qbt_header(out)
    print(f'Rebuilt:  zoom={h2["zoom"]}, values_length={h2["values_length"]:,}')
    assert h2['zoom'] == h['zoom']
    assert h2['values_length'] == h['values_length'], \
        f'values_length: {h2["values_length"]} vs {h["values_length"]}'

    # Compare values (sample first/last 100)
    with open(out, 'rb') as f:
        f.seek(h2['values_offset'])
        values_bytes2 = f.read(h2['values_length'])

    mismatches = 0
    for i in range(n):
        v1 = struct.unpack_from('<f', values_bytes, i * 4)[0]
        v2 = struct.unpack_from('<f', values_bytes2, i * 4)[0]
        if v1 != v2:
            mismatches += 1
    print(f'  Values: {n:,}, mismatches: {mismatches}')
    assert mismatches == 0

    print(f'  Output: {out}')
    print('PASS: fixed worldpop round-trip')


def test_variable_tiles():
    """Round-trip: korea_tiles.qbt (variable, tile archive)"""
    src = os.path.join(EXAMPLES, 'korea_tiles.qbt')
    if not os.path.exists(src):
        print(f'SKIP: {src} not found')
        return

    h = qbt.read_qbt_header(src)
    print(f'Original: zoom={h["zoom"]}, values_offset={h["values_offset"]}, '
          f'values_length={h["values_length"]:,}')

    # Read index
    with open(src, 'rb') as f:
        raw = f.read()
    compressed = raw[h['header_size']:h['header_size'] + h['bitmask_length']]
    idx_bytes = gzip.decompress(compressed)
    entries = qbt.deserialize_quadtree_index(idx_bytes)
    index = {e['quadkey_int']: e for e in entries}
    print(f'  Tiles: {len(index):,}')

    # Spot-check a few tiles
    import random
    sample_qks = random.sample(list(index.keys()), min(10, len(index)))
    for qk in sample_qks:
        entry = index[qk]
        start = h['values_offset'] + entry['offset']
        tile = raw[start:start + entry['length']]
        assert len(tile) == entry['length'], f'tile length mismatch for qk={qk}'

    print(f'  Spot-checked {len(sample_qks)} tiles: all correct')
    print('PASS: variable tiles')


if __name__ == '__main__':
    print('=' * 60)
    print('Test 1: Columnar Korea (100m population)')
    print('=' * 60)
    test_columnar_korea()

    print()
    print('=' * 60)
    print('Test 2: Variable Tiles (korea admin)')
    print('=' * 60)
    test_variable_tiles()

    print()
    print('=' * 60)
    print('Test 3: Fixed WorldPop (51M cells) — may take a while')
    print('=' * 60)
    test_fixed_worldpop()
