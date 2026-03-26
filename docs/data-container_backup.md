# Beyond Tile Indexing — QBTiles as a Data Container

## Smaller File, Finer Access

Raster formats like GeoTIFF store data on a **full rectangular grid** — every pixel occupies space, even when it holds no data. For sparse datasets, most of that space is wasted on nodata values.

Consider the WorldPop 2025 global population grid at 1km resolution: 43,200 × 17,280 = **746 million pixels**, but only **51 million contain valid data** (6.9% occupancy). The other 93% is ocean and uninhabited land — stored as nodata values that the compression algorithm must still process.

QBTiles eliminates this waste entirely. The bitmask tree encodes *which* cells exist; only those cells have values stored. Empty space costs zero bytes.

| Format | Size | Access granularity | Empty cell cost |
|---|---|---|---|
| GeoTIFF int32 deflate | 95 MB | 512×512 block | Compressed nodata values |
| **QBTiles int32 gzip** | **51 MB** | **Per cell (4 bytes)** | **0 bytes** |

This is **46% smaller with 131,072× finer access granularity** — under the same conditions (int32, lossless). These two properties are normally a trade-off: finer access usually requires more metadata overhead, increasing file size. QBTiles achieves both because the bitmask that eliminates empty-cell storage *also* serves as a spatial index for per-cell addressing.

> **Raster formats pay for empty space. QBTiles doesn't.**

The sparser the data, the greater the advantage. At 6.9% occupancy (global population), the reduction is 46%. For sparser datasets — urban footprints, sensor networks, species observations — the gap grows dramatically.

## Partial Access via Range Request

The bitmask structure naturally supports partial access patterns similar to Cloud Optimized GeoTIFF (COG), but at per-cell resolution rather than per-block.

### The Approach

By separating the bitmask index from the value array, a client can:

1. Download only the bitmask (8.7 MB gzip for 51M cells) — once
2. Compute the exact byte offset of any cell: `offset = leaf_index × 4`
3. Fetch only the needed cells via HTTP Range Request

COG requires downloading entire 512×512 blocks even when only a few cells are needed within each block.

### Three Access Strategies

The bitmask structure enables similar partial access without additional index files:

| Strategy | Initial download | Access granularity |
|---|---|---|
| Full download | 51 MB (gzip) | Instant client-side access |
| Bitmask only | 8.7 MB | Per-cell Range Request |
| Level 7 bitmask + lengths | ~hundreds of KB | 512×512 block Range Request |

#### Strategy 1: Full download

Download the entire gzip file, decompress, build lookup. Best when the client needs to explore the full dataset interactively.

#### Strategy 2: Bitmask-first (current — [live demo](https://vuski.github.io/qbtiles/demo/range-request/))

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

### Demo: QBTiles vs COG Range Request

<div markdown="0">
<video controls width="100%" style="max-width:800px">
  <source src="../comparison.mp4" type="video/mp4">
</video>
</div>

### Request Count vs Transfer Size Trade-off

A real-world comparison for a ~2° × 2° selection over South Korea:

| | QBTiles | COG |
|---|---|---|
| Requests | 7 | 2 |
| Bytes | 23.1 KB | 768 KB |
| Cells retrieved | 4,576 | 76,989 |
| Access granularity | Per cell (4 bytes) | Per 512×512 block |

COG transfers **33× more data** with fewer requests. Which matters more?

**Request overhead in practice:**

- HTTP/2+ (standard on CDNs like Cloudflare R2): single connection, multiplexed — 7 requests run nearly simultaneously with no additional handshake cost
- Per-request overhead: ~200–300 bytes of headers × 7 = ~2 KB, negligible
- Request count becomes a bottleneck only beyond ~50 requests at sub-KB payloads

**Transfer cost scales with bytes:**

- CDN egress billing: per byte
- Mobile data plans: per byte
- Battery consumption on mobile: proportional to radio-on time, driven by bytes
- Slow/metered networks (3G, satellite): 33× difference is 33× wait time

QBTiles' `mergeRanges` (gap ≤ 256 indices → merge) balances this: nearby cells become a single request even if not perfectly contiguous, keeping request count low while preserving per-cell precision.

**Conclusion:** In the HTTP/2 era, **fewer bytes + slightly more requests >>> fewer requests + many more bytes**, especially on mobile and metered networks.

### Comparison with Vector Formats

For spatial data with per-cell Range Request access, existing vector formats offer partial solutions:

| | QBTiles | FlatGeobuf | GeoParquet |
|---|---|---|---|
| Spatial index | Bitmask tree (8.7 MB / 51M cells) | R-tree (tens of MB / 51M) | Row group metadata |
| Access granularity | Per cell (4 bytes) | Per feature (~40+ bytes) | Per row group (thousands of rows) |
| ID/coordinate storage | 0 (tree implies position) | lon/lat per feature (16 bytes) | lon/lat per row (16 bytes) |
| 51M cells storage | Index 8.7 MB + values 196 MB | ~1.6 GB+ (coords + attributes) | ~165 MB (Parquet compression) |
| Best for | Regular grids | Irregular vector features | Tabular analytics |

FlatGeobuf is the closest analogy — it supports bbox-based Range Requests to fetch individual features. However, for regular grids, storing explicit coordinates per cell is wasteful: 51M × 16 bytes (lon/lat doubles) = 800 MB of coordinates alone. QBTiles eliminates this entirely by encoding positions structurally in the bitmask tree.

### Server-Side Deployment (Lambda / Worker)

In serverless mode (client-only), QBTiles requires downloading the bitmask index (~8.7 MB) before the first query. For use cases with only 1–2 queries, COG's zero-initial-cost model may transfer fewer total bytes.

Adding a server-side compute layer (Lambda, Cloudflare Worker, etc.) eliminates this trade-off entirely. The server holds the bitmask in memory and computes byte offsets on behalf of the client:

```
Client → Server:  bbox (tens of bytes)
Server → Storage: Range Request for exact cells (KB)
Server → Client:  values only (KB)
```

| | COG + Lambda | QBTiles + Lambda |
|---|---|---|
| Server → Storage traffic | 512×512 blocks (hundreds of KB) | **Exact cells only (KB)** |
| Server CPU | LZW decode + crop | **Offset arithmetic only** |
| Server memory | Block buffer per request | Bitmask 13 MB (resident) |
| Client initial cost | 0 | **0** (index on server) |
| Client query cost | Same | Same |

The key difference is **server-to-storage traffic**: COG must fetch entire compressed blocks and decode them, even when only a few cells are needed. QBTiles computes `offset = leaf_index × value_size` and fetches exactly those bytes — no decompression, no wasted transfer.

This means the per-cell advantage applies **twice**: once between storage and server, and again between server and client. For sparse regions (e.g., Sahara, ocean boundaries), the gap is dramatic — a query that needs 100 cells transfers ~400 bytes from storage with QBTiles vs ~512 KB with COG.

### Initial Index Cost: Trade-off Summary

| Deployment | QBTiles initial cost | Break-even vs COG |
|---|---|---|
| Client-only (serverless) | 8.7 MB bitmask download | ~18 queries |
| Server-side (Lambda/Worker) | 0 (server holds index) | **1st query** |

The bitmask is a one-time cost that amortizes over queries. In interactive exploration (dashboards, analysis tools), users typically issue dozens of queries per session, making the initial download worthwhile. For single-query APIs, server-side deployment eliminates the trade-off entirely.

---

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
