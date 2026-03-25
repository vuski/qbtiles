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

- Quadtree construction: `build_quadtree()`
- Bitmask serialization: `serialize_bitmask()`
- File writers: `write_qbt_variable()`, `write_qbt_fixed()`, `write_qbt_columnar()`
- Header parsing: `read_qbt_header()`
- Quadkey conversion: `tile_to_quadkey_int64()`, `quadkey_int64_to_zxy()`, etc.
- Custom CRS: `encode_custom_quadkey()`, `decode_custom_quadkey()`
- Legacy: `write_tree_bitmask_to_single_file()`, `deserialize_quadtree_index()` (v0.1 compat)

### TypeScript Reader (`src/typescript/`)

Browser-side QBT reading and spatial query:

- Header: `parseQBTHeader()` → `QBTHeader`
- Index loading: `loadQBT()` → header fetch + bitmask download, hash-cached
- Spatial query: `queryBbox()`, `mergeRanges()`, `fetchRanges()`
- Columnar reader: `readColumnarValues()` → `Map<string, number[]>`
- Cache: `clearIndexCache()`, `clearLeafCache()`
- Legacy: `deserializeQuadtreeIndex()` → `Map<bigint, QBTilesIndex>` (v0.1 compat)

### C++ Encoder (`src/cpp/`)

Batch conversion of PMTiles Hilbert tile IDs to QBTiles quadkey int64. Interfaces with Python numpy arrays via pybind11.

## Data Flow

### Variable-entry (Tile Archive)

```
Build time:
  Tile data files
    → Sort by quadkey
    → Build quadtree → serialize_bitmask() + varint arrays
    → write_qbt_variable() → .qbt file (header + gzip(bitmask+varints))

Runtime:
  loadQBT(url)
    → fetch header (128B) → check index hash cache
    → fetch bitmask section → gzip decompress → build lazy tree
    → queryBbox() → mergeRanges() → fetchRanges() via Range Request
```

### Fixed-entry (Raster Grid)

```
Build time:
  Spatial data (coordinates + values)
    → Encode to quadtree → serialize_bitmask()
    → write_qbt_fixed() → .qbt (header + gzip(bitmask) + raw values)
    OR write_qbt_columnar() → .qbt.gz (header + bitmask + columnar values, all gzipped)

Runtime (fixed row):
  loadQBT(url)
    → fetch header → fetch bitmask → build index
    → queryBbox() → leaf indices → Range Request per cell

Runtime (columnar):
  fetch .qbt.gz → decompress → parseQBTHeader() → deserializeBitmaskIndex()
    → readColumnarValues() → Map<fieldName, number[]>
```
