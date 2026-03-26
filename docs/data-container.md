# Beyond Tile Indexing — QBTiles as a Data Container

## From Tile Container to GeoTIFF Alternative

QBTiles was originally developed as an alternative to PMTiles for time-series data where spatial extents remain consistent across periods — eliminating redundant index access. However, we realized that the bitmask's sequential arrangement can drastically reduce coordinate storage costs. This led to a further insight: if every tile's data occupies the same fixed storage size, the data index itself becomes unnecessary.

Could QBTiles then replace single-band or multi-band storage formats like GeoTIFF? Thanks to its quadtree algorithm, QBTiles can skip data-free regions at coarse levels via parent bitmask bits. The sparser the data — global land cover, population grids — the more empty space can be skipped, making it more efficient than GeoTIFF.

## Smaller File, Finer Access

Raster formats like GeoTIFF store data on a **full rectangular grid** — every pixel occupies space, even when it holds no data. For sparse datasets, most of that space is wasted on nodata values.

Consider the WorldPop 2025 global population grid at 1km resolution: 43,200 × 17,280 = **746 million pixels**, but only **51 million contain valid data** (6.9% occupancy). The other 93% is ocean and uninhabited land — stored as nodata values that the compression algorithm must still process.

QBTiles eliminates this waste entirely. The bitmask tree encodes *which* cells exist; only those cells have values stored. Empty space costs zero bytes.

The WorldPop 2025 Population Count data is 276 MB. Converting it to QBTiles yields 204 MB (74%).

Despite being smaller, access via Range Request is possible at the **single-cell level**. Unlike GeoTIFF which accesses data in 512×512 pixel blocks, QBTiles downloads a compressed 8.7 MB bitmask index into memory once, then requests and receives data per cell with zero wasted traffic. Splitting a rectangular region into contiguous byte ranges does increase the number of requests, but in typical client environments where requests are sent concurrently, total response time is faster. In sparse regions, download volume can be less than 1/10 that of GeoTIFF.

Cloud-optimized file formats — those supporting Range Requests — normally face a trade-off between file size and access granularity: finer access requires more metadata overhead, increasing file size. QBTiles achieves both because the bitmask that eliminates empty-cell storage *simultaneously* serves as a spatial index for per-cell addressing.

> **Raster formats pay for empty space. QBTiles doesn't.**

The sparser the data, the greater the advantage. In sparsely populated regions like Africa, partial extraction can require less than 1/10 the download volume.

---

## Measured Performance

### WorldPop Benchmark (51M cells)

- 51,297,957 valid cells out of 746 million total (6.9% occupancy)

Comparing a raster format like GeoTIFF — which must fill in empty space — against QBTiles which stores only valid cells might seem unfair. So we also converted to GeoParquet and other formats for comparison.

| Format                   | Size       | Ratio    | Partial access     | Access unit                  |
| ------------------------ | ---------- | -------- | ------------------ | ---------------------------- |
| FlatGeobuf               | 6,001 MB   | 29.4x    | Range Request      | per feature (~40+ bytes)     |
| GeoParquet               | 700 MB     | 3.4x     | full download only | row group (engine-dependent) |
| Parquet float32 (snappy) | 312 MB     | 1.5x     | full download only | -                            |
| Parquet float32 (gzip)   | 284 MB     | 1.4x     | full download only | -                            |
| GeoTIFF float32 (COG)    | 276 MB     | 1.4x     | Range Request      | 512×512 block                |
| **QBTiles float32**      | **204 MB** | **1.0x** | **Range Request**  | **per cell (4 bytes)**       |

Across all formats, QBTiles is the smallest. It also offers the flexibility of per-cell Range Request access.

The Python `qbtiles` library provides a function to convert GeoTIFF to QBTiles, so you can test and compare directly.

### Comparison with Vector Formats

In this sample, the total QBTiles file is 204 MB — comprising a header under 140 bytes, 9 MB of compressed index, and 195 MB of uncompressed float32 contiguous data. Below is a comparison with similar vector formats.

For spatial data with per-cell Range Request access, existing vector formats offer only partial solutions:

|                       | QBTiles                           | FlatGeobuf                     | GeoParquet                        |
| --------------------- | --------------------------------- | ------------------------------ | --------------------------------- |
| Spatial index         | Bitmask tree (8.7 MB / 51M cells) | R-tree (tens of MB / 51M)      | Row group metadata                |
| Access granularity    | Per cell (4 bytes)                | Per feature (~40+ bytes)       | Per row group (thousands of rows) |
| ID/coordinate storage | 0 (tree implies position)         | lon/lat per feature (16 bytes) | lon/lat per row (16 bytes)        |
| 51M cells storage     | 204 MB                            | 6,001 MB                       | 700 MB                            |
| Best for              | Regular grids                     | Irregular vector features      | Tabular analytics                 |

FlatGeobuf is optimized for irregular vector features. For 51M regular grid points, the per-feature R-tree index entry + FlatBuffers wrapper overhead (~98 bytes/feature) dominates, resulting in an abnormally large file. FlatGeobuf shows reasonable sizes for irregular vector data.

FlatGeobuf is the closest analogy — it supports bbox-based Range Requests to fetch individual features. However, for regular grids, storing explicit coordinates per cell is wasteful: 51M × 16 bytes (lon/lat doubles) = 800 MB of coordinates alone.

---

## Cloud Optimized Format: Partial Access via Range Request

The bitmask structure supports partial access patterns similar to Cloud Optimized GeoTIFF (COG), but at per-cell resolution rather than per-block.

A client can:

1. Download only the bitmask (8.7 MB gzip for 51M cells) — once
2. Compute the exact byte offset of any cell: offset = leaf_index × 4
3. Fetch only the needed cells via HTTP Range Request

If 8.7 MB feels like too much initial overhead, the index size can be reduced: trimming the bitmask by 2–3 levels while increasing the access unit to 4×4 or 8×8 cells. This wastes slightly more space but proportionally reduces initial loading. Such trade-offs are achievable with the current QBTiles specification and API.

### Two Access Strategies by File Size

| Strategy      | Initial download | Access granularity         |
| ------------- | ---------------- | -------------------------- |
| Full download | 51 MB (gzip)     | Instant client-side access |
| Bitmask only  | 8.7 MB           | Per-cell Range Request     |

#### Strategy 1: Full download

If data is stored as integers, spatial autocorrelation causes similar values to be arranged sequentially, yielding good compression ratios. Even a global-scale full file download becomes manageable — WorldPop global population rounded to integers compresses to just 51 MB. Download the entire gzip file, decompress, and build a lookup table. Best when the client needs to explore the full dataset interactively.

#### Strategy 2: Bitmask-first (current — [live demo](https://vuski.github.io/qbtiles/demo/range-request/))

Download the bitmask section, then compute byte offsets from BFS leaf order:

```
offset = data_section_start + leaf_index × value_size
```

File layout:

```
[bitmask section: 12.7 MB raw, 8.7 MB gzip]  ← download once
[value section: 196 MB, float32 × 51M]        ← Range Request per cell
```

### Request Count vs Transfer Size Trade-off in the Cloud

Consider placing data files on a cloud or remote server and making Range Requests for rectangular regions. Splitting the rectangle into contiguous byte ranges increases the number of requests somewhat, but since only the needed data is transferred, total download volume can drop to 33%.

Example: South Korea, ~2° × 2° selection:

|                    | QBTiles            | COG               |
| ------------------ | ------------------ | ----------------- |
| Requests           | 7                  | 2                 |
| Bytes              | 23.1 KB            | 768 KB            |
| Cells retrieved    | 4,576              | 76,989            |
| Access granularity | Per cell (4 bytes) | Per 512×512 block |

COG has fewer requests, but transfers **33× more data**. This slight trade-off may influence the final choice depending on the user's deployment environment.

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

### Demo: QBTiles vs COG Range Request

<div markdown="0">
<video controls width="100%" style="max-width:800px">
  <source src="../comparison.mp4" type="video/mp4">
</video>
</div>

---

## Eliminating Initial Index Cost with Cloud Workers

### Server-Side (Lambda / Worker)

Adding a server-side compute layer (Lambda, Cloudflare Worker, etc.) eliminates the client's initial index download entirely — removing QBTiles' only disadvantage.

In client-only mode, QBTiles requires downloading the bitmask index (~8.7 MB) before the first query. For use cases where a user connects, sends 1–2 queries, and leaves, COG's zero-initial-cost model may transfer fewer total bytes.

However, routing through AWS Lambda or Cloudflare Workers changes the equation. When the server holds the bitmask in memory and computes byte offsets on behalf of the client, the client-side QBTiles experience has virtually no drawbacks.

```
Client → Server:  bbox request (with 10+ requests per single region query being common)
      vs
Server → Storage: Range Request for exact cells (KB)
Server → Client:  single bbox request, receive values only (KB)
```

The per-cell advantage applies twice.

The initial index cost between storage (S3, R2) and server (Lambda, Worker) is negligible — even with many clients, 8.7 MB is transferred only once. And since ongoing queries also transfer less data, internal network traffic benefits as well.

Between server and client, likewise: no initial index download is needed. In nearly all cases, less data than COG travels across the network. In sparse regions (e.g., Sahara, coastal boundaries), the gap becomes dramatic — a query needing 100 valid cells transfers ~400 bytes from storage with QBTiles, while COG may transfer ~512 KB.

### Initial Index Cost

| Deployment                  | QBTiles initial cost      | Break-even vs COG |
| --------------------------- | ------------------------- | ----------------- |
| Client-only (serverless)    | 8.7 MB bitmask download   | ~10 queries       |
| Server-side (Lambda/Worker) | 0 (server holds index)    | **1st query**     |

---

# Binary Search Algorithm: Additional Benefits of the Bitmask

The quadkey-sorted structure enables capabilities beyond basic data retrieval.

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

## Lightweight Client-Side Spatial Analysis Format

Like DuckDB operating on Parquet files locally, QBTiles can serve as a lightweight spatial analysis format for client-side computation. Once downloaded, the decoded arrays support fast spatial operations without a server.

**Measured: South Korea 100m population grid (930K cells × 3 values: total, male, female)**

|               | Parquet (x/y + 3 values, gzip) | QBTiles columnar (gzip)              |
| ------------- | ------------------------------ | ------------------------------------ |
| Download      | 2.9 MB                         | **1.7 MB**                           |
| Spatial query | O(N) coordinate scan           | **O(log N) searchsorted on quadkey** |
| Runtime       | Requires DuckDB/WASM (~5 MB)   | Native arrays, no dependency         |

Key advantages for client-side use:

1. **Smaller download**: 2.9 MB → 1.7 MB for the same data (1.7× smaller)
2. **Built-in spatial index**: Quadkey sorting enables O(log N) range queries without building a secondary index

Of course, for smaller datasets, Parquet's linear scan may be faster — linear scans simply advance byte-by-byte or bit-by-bit, while binary search requires conditional branching. The exact break-even point requires further experimentation.
