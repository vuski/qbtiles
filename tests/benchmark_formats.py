"""
Format size comparison: WorldPop float32 population grid.
Generates Parquet and GeoParquet files from existing QBT/GeoTIFF for benchmarking.

Usage:
  python tests/benchmark_formats.py <path_to_worldpop_geotiff> <path_to_qbt>

Example:
  python tests/benchmark_formats.py worldpop.tif ref/global_pop.qbt
"""
import sys, os, time, struct
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src', 'python'))

RESULTS = os.path.join(os.path.dirname(__file__), 'results')
os.makedirs(RESULTS, exist_ok=True)

try:
    import numpy as np
    import rasterio
    import pandas as pd
    import pyarrow as pa
    import pyarrow.parquet as pq
except ImportError as e:
    print(f"Missing: {e}")
    print("pip install numpy rasterio pandas pyarrow geopandas")
    sys.exit(1)

try:
    import geopandas as gpd
    pass
    HAS_GEO = True
except ImportError:
    HAS_GEO = False
    print("WARNING: geopandas not installed, GeoParquet/FlatGeobuf will be skipped")
    print("  pip install geopandas")

HAS_FIONA = HAS_GEO  # fiona comes with geopandas


def main(tif_path, qbt_path):
    print(f"GeoTIFF: {tif_path}")
    print(f"QBT:     {qbt_path}")
    print()

    # 1. Read GeoTIFF
    print("[1/5] Reading GeoTIFF...", end=" ", flush=True)
    t0 = time.time()
    with rasterio.open(tif_path) as src:
        data = src.read(1)
        transform = src.transform
        nodata = src.nodata
    print(f"{time.time()-t0:.1f}s")

    # Extract valid cells
    print("[2/5] Extracting valid cells...", end=" ", flush=True)
    t0 = time.time()
    rows, cols = np.where(data != nodata)
    values = data[rows, cols]  # float32
    lons = transform[2] + cols * transform[0] + transform[0] / 2
    lats = transform[5] + rows * transform[4] + transform[4] / 2
    n = len(values)
    print(f"{n:,} cells, {time.time()-t0:.1f}s")

    # 2. Parquet (lon, lat, pop) - float32
    print("[3/5] Writing Parquet...", end=" ", flush=True)
    t0 = time.time()
    parquet_path = os.path.join(RESULTS, 'worldpop_float32.parquet')
    table = pa.table({
        'lon': pa.array(lons, type=pa.float32()),
        'lat': pa.array(lats, type=pa.float32()),
        'pop': pa.array(values, type=pa.float32()),
    })
    pq.write_table(table, parquet_path, compression='snappy')
    parquet_size = os.path.getsize(parquet_path)
    print(f"{parquet_size/1024/1024:.1f} MB, {time.time()-t0:.1f}s")

    # Also with gzip compression
    parquet_gz_path = os.path.join(RESULTS, 'worldpop_float32_gzip.parquet')
    pq.write_table(table, parquet_gz_path, compression='gzip')
    parquet_gz_size = os.path.getsize(parquet_gz_path)
    print(f"       Parquet (gzip): {parquet_gz_size/1024/1024:.1f} MB")

    # 3. GeoParquet
    if HAS_GEO:
        print("[4/5] Writing GeoParquet...", end=" ", flush=True)
        t0 = time.time()
        geoparquet_path = os.path.join(RESULTS, 'worldpop_float32.geoparquet')
        from shapely import points as shapely_points
        gdf = gpd.GeoDataFrame({
            'pop': values.astype(np.float32),
        }, geometry=shapely_points(np.column_stack([lons, lats])), crs='EPSG:4326')
        gdf.to_parquet(geoparquet_path)
        geoparquet_size = os.path.getsize(geoparquet_path)
        actual_n = len(gdf)
        print(f"{geoparquet_size/1024/1024:.1f} MB ({actual_n:,} rows), {time.time()-t0:.1f}s")
    else:
        geoparquet_size = None

    # 4. FlatGeobuf
    fgb_size = None
    if HAS_GEO:
        print("[5/7] Writing FlatGeobuf...", end=" ", flush=True)
        t0 = time.time()
        fgb_path = os.path.join(RESULTS, 'worldpop_float32.fgb')
        from shapely import points as shapely_points
        gdf_fgb = gpd.GeoDataFrame({
            'pop': values.astype(np.float32),
        }, geometry=shapely_points(np.column_stack([lons, lats])), crs='EPSG:4326')
        gdf_fgb.to_file(fgb_path, driver='FlatGeobuf')
        fgb_size = os.path.getsize(fgb_path)
        fgb_actual_n = len(gdf_fgb)
        print(f"{fgb_size/1024/1024:.1f} MB ({fgb_actual_n:,} rows), {time.time()-t0:.1f}s")

    # 5. Sizes
    print("[6/7] Collecting sizes...", flush=True)
    tif_size = os.path.getsize(tif_path)
    qbt_size = os.path.getsize(qbt_path)

    print()
    print("=" * 60)
    print(f"WorldPop float32 - {n:,} valid cells")
    print("=" * 60)
    print()
    print(f"{'Format':<35} {'Size':>10} {'Ratio':>8}")
    print("-" * 55)

    results = [
        ("GeoTIFF float32 (COG)", tif_size),
        ("Parquet float32 (snappy)", parquet_size),
        ("Parquet float32 (gzip)", parquet_gz_size),
    ]
    if geoparquet_size is not None:
        results.append(("GeoParquet", geoparquet_size))

    if fgb_size is not None:
        results.append(("FlatGeobuf", fgb_size))

    results.append(("QBTiles float32", qbt_size))

    # Sort by size descending
    results.sort(key=lambda x: -x[1])

    for name, size in results:
        ratio = size / qbt_size
        print(f"{name:<35} {size/1024/1024:>8.1f} MB {ratio:>7.1f}x")

    print()
    print(f"Output files in: {RESULTS}")


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python tests/benchmark_formats.py <geotiff> <qbt>")
        print("Example: python tests/benchmark_formats.py worldpop.tif ref/global_pop.qbt")
        sys.exit(1)

    main(sys.argv[1], sys.argv[2])
