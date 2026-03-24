# QBTiles

**QBTiles** (Quadkey Bitmask Tiles) is a cloud-optimized tile archive index format.

It encodes tile existence as **4-bit bitmasks** in BFS order. The position of each entry is implied by the tree structure, **reducing ID storage cost to zero** — quadkeys are reconstructed from the bitmasks alone.

## Why QBTiles?

When using PMTiles with time-series tile data sharing the same spatial structure, each file requires its own embedded index — even when the tile layout is identical. QBTiles **separates the index from data**, so a single index can serve multiple data files.

## Key Features

- **Smaller index**: 5–48% reduction vs PMTiles depending on dataset density
- **Separated index**: Reuse one index across multiple data files with the same tile structure
- **Simple encoding**: Quadtree bitmask BFS — no Hilbert curve computation needed
- **Cloud-native**: HTTP Range Request for serverless tile serving (S3, R2, etc.)

## Quick Start

### Build an index (Python)

```python
import qbtiles as qbt

# 1. Define tiles — each tile has a position (z/x/y) and a location in the data file
tiles = [
    # (z,  x,  y,  offset, length)
    (3,   6,  3,       0,   1024),
    (3,   6,  4,    1024,   2048),
    (3,   7,  3,    3072,   1536),
    (3,   7,  4,    4608,   1024),
]

# 2. Convert z/x/y to quadkey, sort, build tree, serialize
quadkey_info = []
for z, x, y, offset, length in tiles:
    qk = qbt.tile_to_quadkey_int64(z, x, y)
    quadkey_info.append((qk, "", offset, length, 1))

quadkey_info.sort(key=lambda x: x[0])
root = qbt.build_quadtree(quadkey_info)
qbt.write_tree_bitmask_to_single_file(root, "index.gz")
```

### Read an index & look up a tile (Python)

```python
# 3. Deserialize the index
entries = qbt.deserialize_quadtree_index("index.gz")
index_dict = qbt.build_quadkey_index_dict(entries)

# 4. Look up a tile by z/x/y
qk = qbt.tile_to_quadkey_int64(3, 7, 3)
entry = index_dict[qk]
print(entry["offset"], entry["length"])
# → use offset/length for HTTP Range Request
```

### Read an index in the browser (TypeScript)

```typescript
import { deserializeQuadtreeIndex, tileToQuadkeyInt64 } from './qbtiles';

// After fetching and decompressing index.gz:
const entryMap = deserializeQuadtreeIndex(buffer);
const qk = tileToQuadkeyInt64(3, 7, 3);
const entry = entryMap.get(qk);
// → { offset: 3072, length: 1536 } for HTTP Range Request
```

## Project Structure

```
src/
  python/qbtiles.py        — Index builder & serializer
  typescript/qbtiles.ts    — Client-side reader (browser)
  cpp/                     — Native Hilbert→quadkey encoder (pybind11)
examples/                  — Usage examples & sample data
```

## Status

QBTiles is not a fully mature replacement for PMTiles:

- No hierarchical directory splitting for 100GB+ datasets
- Index building is ~2x slower than PMTiles serialization

## License

MIT
