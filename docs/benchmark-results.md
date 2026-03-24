# Benchmark Results

Comparing PMTiles and QBTiles index sizes using the same tile entries, serialized with gzip compression.

Both formats sort entries by their respective key (tile_id for PMTiles, quadkey for QBTiles) with data arranged in that order.

## Index Size Comparison (gzip)

| Dataset | Entries | PMTiles | QBTiles | Reduction |
|---|---|---|---|---|
| worldmap-boundary | 907 | 2,315 B | 2,164 B | -6.5% |
| adm-korea | 36,149 | 80,891 B | 61,251 B | **-24.3%** |
| seoul_filtered_osm | 12,068 | 25,024 B | 24,640 B | -1.5% |
| korea_filtered_osm | 39,186 | 77,680 B | 76,700 B | -1.3% |
| building-korea-mvt | 35,069 | 74,589 B | 76,333 B | +2.3% |
| korea_osm_all | 39,108 | 84,725 B | 81,440 B | -3.9% |
| dem-mapzen-korea | 60,092 | 150,240 B | 139,537 B | -7.1% |
| osm_z0-z10 | 656,695 | 0.90 MB | 0.95 MB | +5.5% |
| **hillshade_webp_z0_z11_256** | **4,624,740** | **8.34 MB** | **4.36 MB** | **-47.8%** |
| **osm-20240812-full** | **160,819,550** | **300.65 MB** | **235.19 MB** | **-21.8%** |

## Bytes per Entry (gzip)

| Dataset | Entries | PM B/entry | QB B/entry | Diff |
|---|---|---|---|---|
| worldmap-boundary | 907 | 2.55 | 2.39 | -0.17 |
| adm-korea | 36,149 | 2.24 | 1.69 | **-0.54** |
| seoul_filtered_osm | 12,068 | 2.07 | 2.04 | -0.03 |
| korea_filtered_osm | 39,186 | 1.98 | 1.96 | -0.03 |
| building-korea-mvt | 35,069 | 2.13 | 2.18 | +0.05 |
| korea_osm_all | 39,108 | 2.17 | 2.08 | -0.08 |
| dem-mapzen-korea | 60,092 | 2.50 | 2.32 | -0.18 |
| osm_z0-z10 | 656,695 | 1.44 | 1.52 | +0.08 |
| **hillshade_webp_z0_z11_256** | **4,624,740** | **1.89** | **0.99** | **-0.90** |
| **osm-20240812-full** | **160,819,550** | **1.96** | **1.53** | **-0.43** |

## Raw vs Gzip — Full OSM (160M entries)

| | PMTiles | QBTiles | Reduction |
|---|---|---|---|
| raw | 985.81 MB (6.43 B/entry) | 656.85 MB (4.28 B/entry) | **-33.4%** |
| gzip | 300.65 MB (1.96 B/entry) | 235.19 MB (1.53 B/entry) | **-21.8%** |

## Observations

- QBTiles is smaller in 10 of 12 tested files
- Larger and denser datasets benefit more from QBTiles
- hillshade (4.6M entries, dense raster): **47.8% reduction**
- Full OSM (160M entries): **21.8% reduction** (gzip), **33.4% reduction** (raw)
- Pre-compression saving of **2.15 bytes per entry** (6.43 → 4.28) — the effect of not storing tile_id deltas
- gzip narrows the gap because PMTiles' delta patterns also compress well
- QBTiles is larger in: building (+2.3%), osm_z0-z10 (+5.5%) — mixed zoom levels or spatially sparse tiles

## Spatial Grid Data Compression

When used as a data container (not a tile index), the bitmask structure eliminates grid IDs entirely — position is implied by the tree structure. Tested with South Korea's 100m population grid (931,495 cells × 3 values: total, male, female).

| Format | Size | Ratio |
|---|---|---|
| GPKG | 93.0 MB | 55x |
| GPKG + zip | 19.3 MB | 11x |
| GeoTIFF (LZW) | 7.5 MB | 4.5x |
| Parquet | 6.2 MB | 3.7x |
| GeoTIFF (deflate) | 4.5 MB | 2.7x |
| GeoTIFF (deflate) + zip | 4.1 MB | 2.4x |
| Parquet + zip | 3.6 MB | 2.1x |
| **QBTiles bitmask (gzip)** | **1.6 MB** | **1.0x** |

- Grid occupancy: 1.4% (931K out of 67M possible cells) — highly irregular
- GeoTIFF stores the full 8192×8192 raster with NoData; compression helps but cannot match skipping empty cells entirely
- Parquet stores grid IDs explicitly; even compressed, ID overhead remains
- QBTiles stores no IDs — the bitmask itself encodes which cells exist

See [Example: Bitmask as a Data Container](examples/02_bitmask_as_data_container.ipynb) for the full workflow.

## Conditions

- PMTiles: sorted by tile_id, `serialize_directory()` (varint delta encoding, gzip)
- QBTiles: sorted by quadkey, `write_tree_bitmask_to_single_file()` (bitmask BFS + columnar varint, gzip)
