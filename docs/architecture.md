# Architecture

## Background

When using PMTiles with **time-series tile data sharing the same spatial structure**, each file requires its own embedded index — even when the tile layout is identical across timestamps.

PMTiles embeds the index within the data file. When tile sets for the same area and zoom levels exist across multiple time steps, the spatial structure is identical, yet each file must be indexed separately. To address this inefficiency, QBTiles **separates the index from the data**, allowing a single index to be reused across multiple data files.

With the index separated, the encoding was also redesigned. A bitmask approach that directly leverages the inherent quadtree structure of map tiles turned out to produce **smaller indices** than PMTiles as a side benefit.

PMTiles embeds per-file indices because it compresses tile data aggressively — even with the same spatial structure, each entry's offset and length can differ across time steps due to varying compression ratios. QBTiles trades some data-level compression for index reusability. Of course, for standalone single files, QBTiles can compress data just like PMTiles.

QBTiles is not a fully mature replacement for PMTiles. PMTiles supports hierarchical directory splitting for 100GB+ files — QBTiles does not yet have this.

## What is QBTiles

QBTiles (Quadkey Bitmask Tiles) is a cloud-optimized tile archive index format.

Map tiles are inherently a quadtree (zoom level = tree depth). QBTiles leverages this natural structure, encoding **tile existence as 4-bit bitmasks** and serializing via **BFS traversal**.

## Key Differences from PMTiles

| | PMTiles | QBTiles |
|---|---|---|
| Spatial indexing | Hilbert curve (1D mapping) | Quadtree bitmask (tree structure) |
| Tile identification | tile_id delta array | **Not stored** — reconstructed from bitmasks |
| Empty tiles | Gap encoded as delta (costs bytes) | Bit is 0 (costs nothing) |
| Index location | Embedded in data file | **Separate file** |
| Index size | Baseline | 5–40% smaller |

### Why the Index is Smaller

PMTiles records **ID gaps (deltas)** between existing tiles as numbers. Sparse tile distributions lead to larger deltas and more varint bytes.

QBTiles uses a **4-bit bitmask** per parent node to represent all four children's existence at once. Non-existent children are simply 0 bits — zero additional cost. By concatenating bitmasks in BFS order, all quadkeys can be reconstructed without storing tile IDs individually.

### Benefits of Index Separation

The QBTiles index is separate from data files. Multiple data files sharing the same tile structure (same area, same zoom levels) can **reuse a single index**.

## Related Work

All individual techniques in QBTiles already exist. QBTiles' value is their practical combination for geographic tile indexing.

### Sparse Voxel Octree (SVO)

The most directly analogous technique — same idea in 3D. See [Comparison](comparison.md) for details.

### LOUDS (Level-Order Unary Degree Sequence)

Succinct data structure that encodes tree topology in BFS order with minimal bits. Academic foundation similar to QBTiles' bitmask BFS serialization.

### Hierarchical Bitmap

Used as multi-level bitmap indices in databases. Hierarchical structure where child bitmaps exist only where parent bits are 1.

### JBIG2 / JPEG 2000

Image coding that uses quadtree decomposition to recursively encode region existence.

## Components

### Python Builder (`src/python/qbtiles.py`)

Index construction and serialization/deserialization:

- Quadtree construction: `build_quadtree()`
- Index serialization: `write_tree_bitmask_to_single_file()`
- Index deserialization: `deserialize_quadtree_index()`
- Quadkey conversion: `tile_to_quadkey_int64()`, `quadkey_int64_to_zxy()`, etc.
- PMTiles comparison: `serialize_directory()` (for size benchmarking)

### TypeScript Reader (`src/typescript/qbtiles.ts`)

Browser-side index deserialization:

- `deserializeQuadtreeIndex()` → `Map<bigint, QBTilesIndex>`
- `quadkeyInt64ToZXY()`, `tileToQuadkeyInt64()` coordinate conversion

### C++ Encoder (`src/cpp/`)

Batch conversion of PMTiles Hilbert tile IDs to QBTiles quadkey int64. Interfaces with Python numpy arrays via pybind11.

A pre-built `.pyd` file (`tileid_encoder.cp312-win_amd64.pyd`) is included in `examples/`, so Python 3.12 + Windows users can `import tileid_encoder` without CMake builds. Other environments require building from `src/cpp/` with pybind11.

## Data Flow

### Build Time

```
Tile data files
  → Sort by quadkey
  → Merge into single data file (sequential storage)
  → Build quadtree (quadkey_info → QuadTreeNode tree)
  → BFS bitmask serialization + columnar varint + gzip compression
  → index.gz
```

### Runtime (Client)

```
fetch index.gz
  → gzip decompress
  → Reconstruct quadkeys from bitmasks + restore offset/length from varints
  → Map<quadkey_int64, {offset, length, ...}>
  → Viewport tile coordinates → quadkey_int64 → Map lookup
  → HTTP Range Request to load tile from data file
```
