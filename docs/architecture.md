# Architecture

## Background

When using PMTiles with **time-series tile data sharing the same spatial structure**, each file requires its own embedded index — even when the tile layout is identical across timestamps.

PMTiles embeds the index within the data file. When tile sets for the same area and zoom levels exist across multiple time steps, the spatial structure is identical, yet each file must be indexed separately.

Designing an alternative tile index to address this led to a format with three key properties:

1. **Bitmask encoding eliminates coordinate storage.** Cell existence is encoded as 4-bit masks in BFS order — positions are implied by the tree structure, not stored explicitly. This alone reduces index size by 20–30% compared to PMTiles' delta-encoded tile IDs.

2. **Fixed-size value blocks alongside the bitmask enable per-cell Range Request.** By placing values at known offsets (`leaf_index × entry_size`), QBTiles can serve as a raster data container comparable to COG — but with per-cell granularity instead of 512×512 blocks. A columnar layout variant further improves compression for bulk download.

3. **Index hash (SHA-256) enables reuse across time-series files.** Each header stores a hash of the bitmask section. When multiple files share the same spatial structure, the client downloads the bitmask once and verifies subsequent files by comparing the 128-byte header — skipping the index entirely.

## What is QBTiles

QBTiles (Quadkey Bitmask Tiles) is a spatial data format that encodes existence as a tree structure, reducing ID storage cost to zero.

Map tiles and spatial grids are inherently quadtrees (zoom level = tree depth). QBTiles leverages this natural structure, encoding **cell existence as 4-bit bitmasks** and serializing via **BFS traversal**.

![quadkey bitmask structure](quadkey_bitmask.png)

## Three Modes

| Mode | Flags | Use Case | Comparable to |
|------|-------|----------|---------------|
| **Variable-entry** | `0x0` | Tile archives (MVT, PNG) | PMTiles |
| **Fixed row** | `0x1` | Raster grids (Range Request) | COG (GeoTIFF) |
| **Fixed columnar** | `0x3` | Compressed grids (bulk download) | Parquet |

## Key Differences from PMTiles

| | PMTiles | QBTiles |
|---|---|---|
| Spatial indexing | Hilbert curve (1D mapping) | Quadtree bitmask (tree structure) |
| Tile identification | tile_id delta array | **Not stored** — reconstructed from bitmasks |
| Empty tiles | Gap encoded as delta (costs bytes) | Bit is 0 (costs nothing) |
| Index location | Embedded in data file | Embedded, reusable via index hash |
| Index size | Baseline | 20–30% smaller |
| Data modes | Tile archive only | Tile archive + raster grid + columnar |

### Why the Index is Smaller

PMTiles records **ID gaps (deltas)** between existing tiles as numbers. Sparse tile distributions lead to larger deltas and more varint bytes.

QBTiles uses a **4-bit bitmask** per parent node to represent all four children's existence at once. Non-existent children are simply 0 bits — zero additional cost. By concatenating bitmasks in BFS order, all quadkeys can be reconstructed without storing tile IDs individually.

### Index Reuse via Hash

The QBT header contains a SHA-256 hash of the bitmask section. Time-series files with identical spatial structure share the same hash, so the client downloads the bitmask once and reuses it for subsequent files.

## Related Work

All individual techniques in QBTiles already exist. QBTiles' value is their practical combination for geographic data.

### Sparse Voxel Octree (SVO)

The most directly analogous technique — same idea in 3D. See [Comparison](comparison.md) for details.

### LOUDS (Level-Order Unary Degree Sequence)

Succinct data structure that encodes tree topology in BFS order with minimal bits. Academic foundation similar to QBTiles' bitmask BFS serialization.

### Hierarchical Bitmap

Used as multi-level bitmap indices in databases. Hierarchical structure where child bitmaps exist only where parent bits are 1.

## Components

### Python Writer (`src/python/qbtiles.py`)

QBT file construction and serialization:

- **`build()`** — unified builder: auto-detects mode from arguments (`folder` → variable, `columns` → columnar, `values` → fixed), auto-calculates zoom from `cell_size`, auto-calculates origin/extent from coordinates
- **`build(geotiff=)`** — converts GeoTIFF to QBTiles directly (auto-detects cell_size, CRS, origin, extent, nodata)
- Quadtree construction: `build_quadtree()`
- Bitmask serialization: `serialize_bitmask()`
- File writers: `write_qbt_variable()`, `write_qbt_fixed()`, `write_qbt_columnar()`
- Header parsing: `read_qbt_header()`
- Quadkey conversion: `tile_to_quadkey_int64()`, `quadkey_int64_to_zxy()`, etc.

### TypeScript Reader (`src/typescript/`)

Browser-side QBT reading and spatial query:

- **`openQBT(url)`** → `QBT` class — unified loader, auto-detects mode from header flags
- `QBT.getTile(z, x, y)` — fetch tile data (variable mode)
- `QBT.query(bbox)` — spatial query (all modes)
- `QBT.columns` — column values (columnar mode)
- `QBT.addProtocol(maplibregl)` — MapLibre custom protocol (variable mode)
- `QBT.toWGS84(x, y)` / `QBT.fromWGS84(lng, lat)` — CRS conversion via proj4
- `registerCRS(epsg, proj4Def)` — register custom CRS definitions
- Low-level: `parseQBTHeader()`, `queryBbox()`, `mergeRanges()`, `fetchRanges()`, `readColumnarValues()`

### C++ Encoder (`src/cpp/`)

Batch conversion of PMTiles Hilbert tile IDs to QBTiles quadkey int64. Interfaces with Python numpy arrays via pybind11.

## Data Flow

### Variable-entry (Tile Archive)

```
Build time:
  qbt.build("output.qbt", folder="tiles/")
    → Sort by quadkey
    → Build quadtree → serialize_bitmask() + varint arrays
    → write_qbt_variable() → single .qbt file
      [header][gzip(bitmask + varints)][tile_data...]

Runtime:
  openQBT(url)
    → fetch header (128B) → check index hash cache
    → fetch bitmask section → gzip decompress → build index
    → getTile(z, x, y) → Range Request for tile data
    → addProtocol(maplibregl) → MapLibre custom protocol
```

### Fixed-entry (Raster Grid)

```
Build time:
  qbt.build("output.qbt", coords=..., values=..., cell_size=1000)
    → Auto-calculate zoom/origin/extent, snap coords to grid
    → Build quadtree → serialize_bitmask()
    → write_qbt_fixed() → single .qbt file
      [header][gzip(bitmask)][raw values]

  qbt.build("output.qbt.gz", coords=..., columns=..., cell_size=100, crs=5179)
    → write_qbt_columnar() → single .qbt.gz file
      gzip([header][gzip(bitmask)][col1][col2]...)

Runtime (fixed row):
  openQBT(url)
    → fetch header → fetch bitmask via Range Request → build index
    → query(bbox) → leaf indices → Range Request per cell

Runtime (columnar):
  openQBT(url)
    → fetch entire .qbt.gz → decompress → parse header + bitmask + columns
    → columns → Map<fieldName, number[]>
    → query(bbox) → in-memory lookup
```
