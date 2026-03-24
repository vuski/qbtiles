# Beyond Tile Indexing

## Partial Access via Range Request

Currently QBTiles requires downloading the entire file. However, the bitmask structure naturally supports partial access patterns similar to Cloud Optimized GeoTIFF (COG).

### The Problem

A global population grid (WorldPop 1km, 51M valid cells) stored as GeoTIFF int32 with deflate compression is 95 MB. QBTiles reduces this to 51 MB under the same conditions (int32, lossless) — a **46% reduction**. However, the entire QBTiles file must be downloaded before any cell can be read.

COG solves this with internal 512×512 tiles: the client reads the header (tile offset table), then fetches only the needed blocks via HTTP Range Request.

### Three Access Strategies

The bitmask structure enables similar partial access without additional index files:

| Strategy | Initial download | Access granularity |
|---|---|---|
| Full download | 51 MB (gzip) | Instant client-side access |
| Bitmask only | 8.7 MB | Per-cell Range Request |
| Level 7 bitmask + lengths | ~hundreds of KB | 512×512 block Range Request |

#### Strategy 1: Full download (current)

Download the entire gzip file, decompress, build lookup. Best when the client needs to explore the full dataset interactively.

#### Strategy 2: Bitmask-first

Download only the bitmask section (8.7 MB for 51M cells). Since the bitmask encodes the BFS order of all leaves, the client can compute the exact byte offset of any cell:

```
offset = data_section_start + leaf_index × value_size
```

The leaf index is determined by counting leaves in BFS order up to the target quadkey — which only requires the bitmask. The value section can remain uncompressed on the server for direct Range Request access.

File layout:
```
[bitmask section: 12.7 MB raw, 8.7 MB gzip]  ← download once
[value section: 196 MB, float32 × 51M]        ← Range Request per cell
```

#### Strategy 3: Two-level index

Download only the top levels (e.g., Level 0–7) of the bitmask plus a length table for each Level 7 node. Since zoom 16 - zoom 7 = 9 levels = 512×512 blocks, this mirrors COG's tile structure.

```
[Level 0–7 bitmask + per-node leaf counts]  ← ~hundreds of KB, first request
[value section]                              ← Range Request per 512×512 block
```

This is structurally equivalent to COG's TileOffsets table, but the tile IDs are implicit in the bitmask rather than stored explicitly.

### Measured Sizes (WorldPop 2025, global 1km population)

51,297,957 valid cells out of 746,496,000 total (6.9% occupancy).

**Bitmask breakdown:**

| Section | Raw | Gzip |
|---|---|---|
| Bitmask | 12.7 MB | 8.7 MB |
| Values (int32) | 231.3 MB | 42.1 MB |
| Total | 244.0 MB | 50.8 MB |

Bitmask overhead: 5.2% of raw, ~17.2% of gzip.

**Format comparison (int32, lossless):**

| Format | Size |
|---|---|
| GeoParquet | 549 MB |
| GeoParquet + zip | 311 MB |
| GeoTIFF float32 (original COG) | 277 MB |
| Parquet (lon/lat/pop) | 165 MB |
| Parquet + zip | 130 MB |
| GeoTIFF int32 deflate | 95 MB |
| Values only int32 gzip | 57 MB |
| **QBTiles int32 gzip** | **51 MB** |

**Float32 compression (lossless, values only):**

| Type | Raw | Gzip | Ratio |
|---|---|---|---|
| float32 | 196 MB | 184 MB | 93.8% |
| int32 (rounded) | 196 MB | 57 MB | 29.2% |

Float32 bit patterns are too irregular for gzip to compress effectively. Integer rounding enables 3.2× better compression.

## Time-Series with Roaring Bitmap

When time-series data shares similar but not identical spatial extents (e.g., global population across years where measurement boundaries change), a union bitmask can be combined with per-year Roaring Bitmaps:

```
Shared:   QBTiles bitmask (union of all years → quadkey array)
Per-year: Roaring Bitmap (valid cell indices) + value array (valid cells only)
```

This avoids zero-padding for missing cells while maintaining the shared spatial index. Roaring Bitmaps compress contiguous integer ranges extremely well, making the per-year overhead minimal.

Trade-off: adds a JavaScript dependency (e.g., roaring-wasm) and implementation complexity. For time-series where valid cells are nearly identical across years, simple zero-padding with gzip may be sufficient.

## Spatial Range Query via Quadkey Prefix

Decoded QBTiles entries are sorted by quadkey (Z-order curve), which preserves spatial hierarchy. A subregion query reduces to binary search on a sorted array:

```python
shift = 2 * (leaf_zoom - parent_zoom)
qk_min = parent_qk << shift
qk_max = qk_min | ((1 << shift) - 1)
i_start = np.searchsorted(qk_arr, qk_min)
i_end = np.searchsorted(qk_arr, qk_max, side='right')
# → qk_arr[i_start:i_end] is the contiguous subregion
```

This is **O(log N)** — compared to O(N) for coordinate-based filtering. Hilbert-curve-based tile IDs (PMTiles) do not share prefixes across zoom levels, so this contiguous-range property is unique to quadkey/Z-order encoding.

## Client-Side Spatial Analysis

Like DuckDB operating on Parquet files locally, QBTiles can serve as a lightweight spatial analysis format for client-side computation. Once downloaded, the decoded arrays support fast spatial operations without a server.

**Measured: WorldPop global 1km population (51M cells, rounded to int32)**

| | Parquet (lon/lat/pop) | QBTiles |
|---|---|---|
| Download | 165 MB | **51 MB** |
| Spatial query | O(N) coordinate scan | **O(log N) searchsorted on quadkey** |
| Runtime | Requires DuckDB/WASM (~5 MB) | Native arrays, no dependency |

The key advantages for client-side use:

1. **Smaller download**: No coordinate/ID storage — 165 MB → 51 MB for the same data
2. **Built-in spatial index**: Quadkey sorting enables O(log N) range queries without building a secondary index
3. **Zero dependency**: Decoded data is just sorted arrays — works with numpy, plain JavaScript TypedArrays, or any language
