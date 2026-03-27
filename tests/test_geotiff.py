"""
GeoTIFF → QBT round-trip test using build(geotiff=).
Usage: python tests/test_geotiff.py <path_to_geotiff>
"""
import sys, os, struct, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src', 'python'))

import qbtiles as qbt

RESULTS = os.path.join(os.path.dirname(__file__), 'results')
os.makedirs(RESULTS, exist_ok=True)

try:
    import rasterio
    import numpy as np
except ImportError:
    print("ERROR: pip install rasterio numpy")
    sys.exit(1)


def test_geotiff(tif_path, nodata=None):
    print(f"Input: {tif_path}")
    print(f"Size: {os.path.getsize(tif_path) / 1024 / 1024:.1f} MB")

    # 1. Read original GeoTIFF info
    with rasterio.open(tif_path) as src:
        print(f"Dimensions: {src.width} × {src.height}")
        print(f"Bands: {src.count}")
        print(f"CRS: {src.crs}")
        print(f"Pixel: {abs(src.transform[0])} × {abs(src.transform[4])}")
        print(f"Bounds: {src.bounds}")
        print(f"Nodata: {src.nodata}")
        print(f"Dtype: {src.dtypes[0]}")

        nodata = src.nodata
        data = src.read(1)
        if nodata is not None:
            valid = int(np.sum(data != nodata))
        else:
            valid = data.size
        print(f"Valid cells: {valid:,} / {data.size:,} ({valid/data.size*100:.1f}%)")

    # 2. Convert using build(geotiff=)
    base = os.path.splitext(os.path.basename(tif_path))[0]
    qbt_path = os.path.join(RESULTS, base + '.qbt')
    print(f"\nConverting to {qbt_path}...")
    t0 = time.time()

    qbt.build(qbt_path, geotiff=tif_path, nodata=nodata)

    elapsed = time.time() - t0
    print(f"Total: {elapsed:.1f}s")

    # 3. Check output
    qbt_size = os.path.getsize(qbt_path)
    tif_size = os.path.getsize(tif_path)
    h = qbt.read_qbt_header(qbt_path)
    n_cells = h['values_length'] // h['entry_size'] if h['entry_size'] > 0 else 0

    print(f"\nQBT file: {qbt_size / 1024 / 1024:.1f} MB")
    print(f"Ratio: {qbt_size / tif_size * 100:.1f}% of original")
    print(f"zoom={h['zoom']}, crs={h['crs']}")
    print(f"origin=({h['origin_x']}, {h['origin_y']})")
    print(f"extent=({h['extent_x']}, {h['extent_y']})")
    print(f"cell_size={h['extent_x'] / (2 ** h['zoom'])}")
    print(f"values_offset={h['values_offset']:,}")
    print(f"values_length={h['values_length']:,} ({n_cells:,} cells)")
    print(f"fields={h['fields']}")

    # Metadata
    if h['metadata_offset'] > 0:
        with open(qbt_path, 'rb') as f:
            f.seek(h['metadata_offset'])
            meta = f.read(h['metadata_length'])
        print(f"Metadata: {meta.decode()}")

    # 4. Summary
    print(f"\n{'='*50}")
    print(f"GeoTIFF: {tif_size/1024/1024:.1f} MB ({data.size:,} pixels, {valid:,} valid)")
    print(f"QBT:     {qbt_size/1024/1024:.1f} MB ({n_cells:,} cells)")
    print(f"Reduction: {(1 - qbt_size/tif_size)*100:.1f}%")
    print(f"Cell count match: {n_cells == valid}")

    if n_cells != valid:
        print(f"WARNING: cell count mismatch! QBT={n_cells:,}, GeoTIFF valid={valid:,}")

    print(f"\nOutput: {qbt_path}")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python tests/test_geotiff.py <path_to_geotiff> [--nodata VALUE]")
        print("Example: python tests/test_geotiff.py worldpop.tif --nodata 0")
        sys.exit(1)

    nodata_val = None
    if '--nodata' in sys.argv:
        idx = sys.argv.index('--nodata')
        nodata_val = float(sys.argv[idx + 1])
        if nodata_val == int(nodata_val):
            nodata_val = int(nodata_val)

    test_geotiff(sys.argv[1], nodata=nodata_val)
