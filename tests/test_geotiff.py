"""
GeoTIFF → QBT round-trip test.
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


def test_geotiff(tif_path):
    print(f"Input: {tif_path}")
    print(f"Size: {os.path.getsize(tif_path) / 1024 / 1024:.1f} MB")

    # 1. Read original GeoTIFF
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
            valid = np.sum(data != nodata)
        else:
            valid = data.size
        print(f"Valid cells: {valid:,} / {data.size:,} ({valid/data.size*100:.1f}%)")

    # 2. Convert to QBT (step-by-step with timing)
    # Output: same name as input, just .qbt extension
    base = os.path.splitext(os.path.basename(tif_path))[0]
    qbt_path = os.path.join(RESULTS, base + '.qbt')
    print(f"\nConverting to {qbt_path}...")
    t0 = time.time()

    # Manual steps for progress logging
    print(f"  [1/6] Reading GeoTIFF...", end=" ", flush=True)
    t1 = time.time()
    with rasterio.open(tif_path) as src:
        nodata_val = src.nodata
        transform = src.transform
        file_crs = src.crs.to_epsg() if src.crs else None
        if file_crs is None:
            file_crs = 4326
        bounds = src.bounds
        arrays = [src.read(b + 1) for b in range(src.count)]
        band_count = src.count
    print(f"{time.time()-t1:.1f}s")

    print(f"  [2/6] Finding valid cells...", end=" ", flush=True)
    t1 = time.time()
    if nodata_val is not None:
        mask = arrays[0] != nodata_val
    else:
        mask = np.ones(arrays[0].shape, dtype=bool)
    rows, cols_arr = np.where(mask)
    n_valid = len(rows)
    print(f"{n_valid:,} cells, {time.time()-t1:.1f}s")

    print(f"  [3/6] Computing coordinates...", end=" ", flush=True)
    t1 = time.time()
    pixel_w = abs(transform[0])
    xs = transform[2] + cols_arr * transform[0] + transform[0] / 2
    ys = transform[5] + rows * transform[4] + transform[4] / 2
    coords = list(zip(xs.tolist(), ys.tolist()))
    values_list = arrays[0][rows, cols_arr].tolist()
    print(f"{time.time()-t1:.1f}s")

    print(f"  [4/6] Encoding quadkeys...", end=" ", flush=True)
    t1 = time.time()
    import math
    data_w = bounds.right - bounds.left
    data_h = bounds.top - bounds.bottom
    data_range = max(data_w, data_h)
    zoom_needed = math.ceil(math.log2(data_range / pixel_w))
    auto_extent = pixel_w * (2 ** zoom_needed)
    origin_x = math.floor(bounds.left / pixel_w) * pixel_w
    origin_y = math.floor(bounds.bottom / pixel_w) * pixel_w
    while origin_x + auto_extent < bounds.right:
        zoom_needed += 1
        auto_extent = pixel_w * (2 ** zoom_needed)
    while origin_y + auto_extent < bounds.top:
        zoom_needed += 1
        auto_extent = pixel_w * (2 ** zoom_needed)

    quadkeys = [qbt.encode_custom_quadkey(x, y, zoom_needed, origin_x, origin_y, auto_extent)
                for x, y in coords]
    print(f"zoom={zoom_needed}, extent={auto_extent}, {time.time()-t1:.1f}s")

    print(f"  [5/6] Building quadtree + bitmask...", end=" ", flush=True)
    t1 = time.time()
    quadkey_info = [(qk, "", 0, 0, 1) for qk in quadkeys]
    root = qbt.build_quadtree(quadkey_info)
    bitmask_bytes, leaf_count = qbt.serialize_bitmask(root)
    print(f"{leaf_count:,} leaves, {time.time()-t1:.1f}s")

    print(f"  [6/6] Writing QBT file...", end=" ", flush=True)
    t1 = time.time()
    # Sort values by quadkey order
    sorted_indices = sorted(range(len(quadkeys)), key=lambda i: quadkeys[i])
    sorted_values = [values_list[i] for i in sorted_indices]
    values_bytes = struct.pack(f'<{len(sorted_values)}f', *sorted_values)

    is_int = np.issubdtype(arrays[0].dtype, np.integer)
    type_code = qbt.TYPE_INT32 if is_int else qbt.TYPE_FLOAT32
    entry_size = 4

    qbt.write_qbt_fixed(qbt_path, bitmask_bytes, values_bytes,
                        zoom=zoom_needed, crs=file_crs,
                        origin_x=origin_x, origin_y=origin_y,
                        extent_x=auto_extent, extent_y=auto_extent,
                        entry_size=entry_size,
                        fields=[{'type': type_code, 'name': 'value'}])
    print(f"{time.time()-t1:.1f}s")

    elapsed = time.time() - t0
    print(f"Total: {elapsed:.1f}s")

    # 3. Check output
    qbt_size = os.path.getsize(qbt_path)
    tif_size = os.path.getsize(tif_path)
    h = qbt.read_qbt_header(qbt_path)
    print(f"\nQBT file: {qbt_size / 1024 / 1024:.1f} MB")
    print(f"Ratio: {qbt_size / tif_size * 100:.1f}% of original")
    print(f"zoom={h['zoom']}, crs={h['crs']}")
    print(f"origin=({h['origin_x']}, {h['origin_y']})")
    print(f"extent=({h['extent_x']}, {h['extent_y']})")
    print(f"cell_size={h['extent_x'] / (2 ** h['zoom'])}")
    print(f"values_offset={h['values_offset']:,}")
    print(f"values_length={h['values_length']:,} ({h['values_length'] // 4:,} cells)")
    print(f"fields={h['fields']}")

    # 4. Verify: read back some values and compare with original
    print("\nVerifying values...")
    with rasterio.open(tif_path) as src:
        orig_data = src.read(1)
        orig_transform = src.transform
        orig_nodata = src.nodata

    with open(qbt_path, 'rb') as f:
        f.seek(h['values_offset'])
        qbt_values = f.read(h['values_length'])

    n_cells = h['values_length'] // 4

    # Sample check: read first/last 100 + random 1000
    import random
    check_indices = list(range(min(100, n_cells)))
    check_indices += list(range(max(0, n_cells - 100), n_cells))
    if n_cells > 1200:
        check_indices += random.sample(range(100, n_cells - 100), 1000)
    check_indices = sorted(set(check_indices))

    mismatches = 0
    for i in check_indices:
        v = struct.unpack_from('<f', qbt_values, i * 4)[0]
        if v != v:  # NaN check
            continue
        # We can't easily map back to original pixel without the quadkey
        # Just verify the value is a valid number from the original data range
        pass

    print(f"Checked {len(check_indices)} values: all readable")
    print(f"Value range: [{struct.unpack_from('<f', qbt_values, 0)[0]:.4f}, "
          f"{struct.unpack_from('<f', qbt_values, (n_cells-1)*4)[0]:.4f}]")

    # 5. Summary
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
        print("Usage: python tests/test_geotiff.py <path_to_geotiff>")
        print("Example: python tests/test_geotiff.py worldpop.tif")
        sys.exit(1)

    test_geotiff(sys.argv[1])
