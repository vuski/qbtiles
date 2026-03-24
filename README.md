# QBTiles

**QBTiles** (Quadkey Bitmask Tiles) is a cloud-optimized tile archive index format that uses quadtree bitmask encoding to achieve smaller index sizes compared to [PMTiles](https://github.com/protomaps/PMTiles).

**[Documentation](https://vuski.github.io/qbtiles/)** | **[한국어 문서](https://vuski.github.io/qbtiles/ko/)**

## Motivation

When using PMTiles with time-series tile data sharing the same spatial structure, each file requires its own embedded index — even when the tile layout is identical across timestamps. QBTiles **separates the index from data**, allowing a single index to be reused across multiple data files.

As a side effect, the quadtree bitmask encoding turned out to produce **smaller indices** than PMTiles' Hilbert curve approach.

## How It Works

Map tiles are inherently a quadtree (zoom level = tree depth). QBTiles encodes **tile existence as 4-bit bitmasks** in BFS order. The position of each entry is implied by the tree structure, **reducing ID storage cost to zero** — quadkeys are reconstructed from the bitmasks alone.

```
Level 1:  [0100]          → only child 1 exists
Level 2:  [0001]          → only child 3 exists
Level 3:  [0010]          → only child 2 exists
...
```

![quadkey bitmask structure](https://raw.githubusercontent.com/vuski/qbtiles/main/docs/quadkey_bitmask.png)

### Key Differences from PMTiles

| | PMTiles | QBTiles |
|---|---|---|
| Spatial indexing | Hilbert curve (1D mapping) | Quadtree bitmask (tree structure) |
| Tile identification | tile_id delta array | **Not stored** — reconstructed from bitmasks |
| Empty tiles | Gap encoded as delta (costs bytes) | Bit is 0 (costs nothing) |
| Index location | Embedded in data file | **Separate file** |

## Benchmark Results

Tested against real PMTiles files (gzip compressed):

| Dataset | Entries | PMTiles | QBTiles | Reduction |
|---|---|---|---|---|
| adm-korea | 36,149 | 80,891 B | 61,251 B | **-24.3%** |
| hillshade_z0_z11 | 4,624,740 | 8.34 MB | 4.36 MB | **-47.8%** |
| osm-20240812-full | 160,819,550 | 300.65 MB | 235.19 MB | **-21.8%** |

Full benchmark: [benchmark-results.md](docs/benchmark-results.md)

### Bytes per Entry (gzip)

| Dataset | PMTiles | QBTiles |
|---|---|---|
| hillshade (dense raster) | 1.89 B/entry | **0.99 B/entry** |
| Full OSM (160M entries) | 1.96 B/entry | **1.53 B/entry** |

## Index Format

The index is a **gzip-compressed binary** file:

```
[4-byte header: bitmask section length]
[Bitmask section: 4-bit pairs packed into bytes, BFS order]
[Varint section (columnar): run_lengths[] → lengths[] → offsets[]]
```

- **Bitmask section**: Each node's child presence encoded as 4 bits (8=child0, 4=child1, 2=child2, 1=child3), two per byte
- **Varint section**: Stored column-wise (same type values together) for better gzip compression
- **Offset delta encoding**: Same as PMTiles — contiguous tiles encoded as 0, others as offset+1

Full spec: [format-spec.md](docs/format-spec.md)

## Quadkey Int64 Encoding

Quadkeys use a **`0b11` prefix sentinel** to avoid ambiguity when converting to integers:

```
"0"   → "30"   → int 12     (zoom 1)
"00"  → "300"  → int 48     (zoom 2)
"032" → "3032" → int 206    (zoom 3)
```

Supports zoom levels 0–31 within a 64-bit integer.

Details: [quadkey-encoding.md](docs/quadkey-encoding.md)

## Bitmask as a Data Container

Beyond tile indexing, the bitmask structure can serve as a **spatial data compression format**. Instead of storing tile offsets, values (e.g., population counts) are stored directly at leaf nodes. The bitmask implicitly encodes *where* each value belongs — no coordinate or grid ID storage needed.

**Example: Korea 100m population grid (931,495 cells × 3 values, 1.4% grid occupancy)**

| Format | Size | vs QBTiles |
|---|---|---|
| GPKG | 93.0 MB | 55x |
| GPKG + zip | 19.3 MB | 11x |
| GeoTIFF (deflate) | 4.5 MB | 2.7x |
| Parquet + zip | 3.6 MB | 2.1x |
| **QBTiles bitmask** | **1.6 MB** | **1.0x** |

The bitmask eliminates grid IDs entirely — position is encoded by the tree structure itself. This makes it particularly effective for irregularly distributed spatial data (e.g., populated areas with large empty regions).

## Related Work

QBTiles combines existing techniques — none of the individual methods are new:

- **Sparse Voxel Octree (SVO)**: Same bitmask idea in 3D (8-bit masks). SVO uses row-oriented layout for GPU ray traversal; QBTiles uses column-oriented layout for network transfer. ([comparison](docs/comparison.md))
- **LOUDS**: Succinct tree encoding via BFS bit sequences
- **PMTiles**: Hilbert curve tile indexing with varint delta encoding

## Quick Start

### Python — Build an Index

```python
import qbtiles as qbt

# Create tile entries: (quadkey_int64, path, offset, length, run_length)
quadkey_info = []
for z, x, y, offset, length in tiles:
    qk = qbt.tile_to_quadkey_int64(z, x, y)
    quadkey_info.append((qk, "", offset, length, 1))

quadkey_info.sort(key=lambda x: x[0])

# Build and serialize
root = qbt.build_quadtree(quadkey_info)
qbt.write_tree_bitmask_to_single_file(root, "index.gz")
```

### TypeScript — Read an Index

```typescript
import { deserializeQuadtreeIndex, tileToQuadkeyInt64 } from './qbtiles';

// After fetching and decompressing index.gz:
const entryMap = deserializeQuadtreeIndex(buffer);
const qk = tileToQuadkeyInt64(z, x, y);
const entry = entryMap.get(qk);
// → { offset, length, ... } for HTTP Range Request
```

### Custom Coordinate Systems

QBTiles works with any coordinate system, not just web map tiles:

```python
import qbtiles as qbt

# EPSG:5179, 100m grid → zoom 13 (819200 / 2^13 = 100)
origin_x, origin_y, extent = 700000, 600000, 819200

qk = qbt.encode_custom_quadkey(x, y, zoom=13, origin_x=origin_x, origin_y=origin_y, extent=extent)
x, y = qbt.decode_custom_quadkey(qk, zoom=13, origin_x=origin_x, origin_y=origin_y, extent=extent)
```

## Examples

- [`01_xyz_tiles.py`](examples/01_xyz_tiles.py) — Standard XYZ web tiles
- [`02_custom_crs.py`](examples/02_custom_crs.py) — Custom coordinate system with `fit_grid()`
- [`03_web_client.html`](examples/03_web_client.html) — Browser-based index reader
- [`04_compare_pmtiles.py`](examples/04_compare_pmtiles.py) — PMTiles vs QBTiles size comparison
- [`05_compare_real_pmtiles.ipynb`](examples/05_compare_real_pmtiles.ipynb) — Real PMTiles file comparison
- [`sample_adm_korea.pmtiles`](examples/sample_adm_korea.pmtiles) — Sample PMTiles file (29MB) for testing

## Project Structure

```
src/
  python/qbtiles.py        — Index builder & serializer/deserializer
  typescript/qbtiles.ts    — Client-side index reader (browser)
  cpp/                     — Native encoder: Hilbert tile_id → quadkey (pybind11)
examples/                  — Usage examples & sample data
docs/                   — Detailed documentation (Korean)
```

## Documentation

Detailed documentation in Korean:

- [Architecture](docs/architecture.md) — Background, design decisions, data flow
- [Format Spec](docs/format-spec.md) — Binary format specification
- [Quadkey Encoding](docs/quadkey-encoding.md) — Int64 prefix encoding
- [Comparison](docs/comparison.md) — PMTiles & SVO comparison
- [Benchmark Results](docs/benchmark-results.md) — Real-world size comparison

## Status

QBTiles is not a fully mature replacement for PMTiles. Notable limitations:

- No hierarchical directory splitting for very large datasets (PMTiles splits into root + leaf directories for 100GB+ files)
- Index building is slower than PMTiles serialization (~2x due to quadtree construction)

## License

MIT
