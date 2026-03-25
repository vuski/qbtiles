# QBTiles

**QBTiles** (Quadkey Bitmask Tiles) — a spatial data format that encodes existence as a tree structure, reducing ID storage cost to zero.

**[Documentation](https://vuski.github.io/qbtiles/)** | **[Live Demos](https://vuski.github.io/qbtiles/demo/)** | **[한국어 문서](https://vuski.github.io/qbtiles/ko/)**

## Install

```bash
# Python — build & write QBT files
pip install qbtiles

# TypeScript/JavaScript — read & query QBT files in the browser
npm install qbtiles
```

## What It Does

Map tiles and spatial grids are inherently quadtrees. QBTiles encodes **cell existence as 4-bit bitmasks** in BFS order. The position of each entry is implied by the tree structure — **no IDs, no coordinates stored**.

```
Level 1:  [0100]          → only child 1 exists
Level 2:  [0001]          → only child 3 exists
Level 3:  [0010]          → only child 2 exists
```

![quadkey bitmask structure](https://raw.githubusercontent.com/vuski/qbtiles/main/docs/quadkey_bitmask.png)

### Three Modes

| Mode | Flags | Use Case | Access | Comparable to |
|------|-------|----------|--------|---------------|
| **Variable-entry** | `0x0` | Tile archives (MVT, PNG) | Per tile | PMTiles |
| **Fixed row** | `0x1` | Raster grids | Per cell (Range Request) | COG (GeoTIFF) |
| **Fixed columnar** | `0x3` | Compressed grids | Whole file (gzip) | Parquet |

## Benchmarks

### Variable-entry — Tile Index (vs PMTiles)

| Dataset | Entries | PMTiles | QBTiles | Reduction |
|---|---|---|---|---|
| adm-korea | 36K rows | 80.9 KB | 61.3 KB | **-24.3%** |
| Full OSM | 160M rows | 300.7 MB | 235.2 MB | **-21.8%** |

### Fixed row — Raster Grid (vs COG)

WorldPop 1km global population, 51M cells, float32:

| Format | Size | Per-cell access |
|---|---|---|
| COG (GeoTIFF) | 290 MB | 512×512 block |
| **QBTiles fixed row** | **204 MB** | **Single cell** |

### Fixed columnar — Compressed Grid (vs Parquet)

Korea 100m population, 931K cells × 3 values:

| Format | Size | Per cell |
|---|---|---|
| GeoParquet | ~20 MB | 21+ Byte |
| Parquet + zip | 3.6 MB | 3.9 Byte |
| **QBTiles columnar** | **1.75 MB** | **1.97 Byte** |

## Quick Start

### Python — Write a QBT File

```python
import qbtiles as qbt
import struct

# 1. Build quadtree from z/x/y tile coordinates
#    entries: [(quadkey_int64, filepath, byte_offset, byte_length, run_length), ...]
entries = [
    (qbt.tile_to_quadkey_int64(5, 27, 12), "tiles/5/27/12.mvt", 0, 4820, 1),
    (qbt.tile_to_quadkey_int64(5, 27, 13), "tiles/5/27/13.mvt", 4820, 3210, 1),
    # ...
]
root = qbt.build_quadtree(entries)

# 2. Serialize bitmask
bitmask, leaf_count = qbt.serialize_bitmask(root)

# 3a. Fixed row — one float32 value per cell (for Range Request)
#     values_bytes: leaf_count × entry_size bytes, same order as bitmask leaves
values = [52.3, 41.2, 0.0, 31.8]  # population per cell
values_bytes = struct.pack(f"<{leaf_count}f", *values)

qbt.write_qbt_fixed("population.qbt", bitmask, values_bytes,
    zoom=16, crs=4326,
    origin_x=-180.0, origin_y=84.0, extent_x=360.0, extent_y=144.0,
    entry_size=4,
    fields=[{"type": qbt.TYPE_FLOAT32, "offset": 0, "name": "population"}])

# 3b. Columnar — multiple varint columns (gzip-compressed whole file)
#     Each list has leaf_count elements in bitmask leaf order
totals  = [523, 412, 0, 318]   # total population per cell
males   = [261, 205, 0, 159]   # male population per cell
females = [262, 207, 0, 159]   # female population per cell

qbt.write_qbt_columnar("population.qbt.gz", bitmask,
    columns=[(qbt.TYPE_VARINT, totals), (qbt.TYPE_VARINT, males), (qbt.TYPE_VARINT, females)],
    leaf_count=leaf_count, zoom=13, crs=5179,
    origin_x=700000.0, origin_y=1300000.0, extent_x=819200.0, extent_y=819200.0,
    fields=[
        {"type": qbt.TYPE_VARINT, "offset": 0, "name": "total"},
        {"type": qbt.TYPE_VARINT, "offset": 0, "name": "male"},
        {"type": qbt.TYPE_VARINT, "offset": 0, "name": "female"},
    ])

# Read back header
header = qbt.read_qbt_header("population.qbt")
# header['zoom'], header['fields'], header['index_hash'], ...
```

### TypeScript — Read & Query (Fixed Row, Range Request)

```typescript
import { loadQBT, queryBbox, mergeRanges, fetchRanges } from 'qbtiles';

const url = 'https://example.com/population.qbt';

// Load index (fetches 128B header + bitmask, hash-cached)
const { header, index } = await loadQBT(url);

// Spatial query → fetch only matching cells via Range Request
const grid = { zoom: 16, originLon: -180, originLat: 84, pixelDeg: 1/120, rasterCols: 43200, rasterRows: 17280 };
const result = queryBbox(index, [126.8, 37.4, 127.2, 37.7], grid);
const ranges = mergeRanges(result.leafIndices, 256, header.entrySize);
const { values } = await fetchRanges(url, ranges, undefined, undefined, header.valuesOffset);
// values.get(leafIndex) → population value
```

### TypeScript — Read Columnar (Whole File)

```typescript
import { parseQBTHeader, deserializeBitmaskIndex, readColumnarValues } from 'qbtiles';

// Fetch and decompress .qbt.gz
const res = await fetch('https://example.com/population.qbt.gz');
const compressed = await res.arrayBuffer();
const ds = new DecompressionStream('gzip');
const writer = ds.writable.getWriter();
writer.write(new Uint8Array(compressed));
writer.close();
const buffer = await new Response(ds.readable).arrayBuffer();

// Parse header → build index → read columnar values
const header = parseQBTHeader(buffer);
const index = await deserializeBitmaskIndex(buffer, header.zoom, undefined,
  { bitmaskByteLength: header.bitmaskLength, bufferOffset: header.headerSize });
const columns = readColumnarValues(buffer, header, index.totalLeaves);
// columns: Map<string, number[]> — field name → values in BFS leaf order
// columns.get('total')  → [523, 412, 0, 318, ...]  (931,495 cells)
// columns.get('male')   → [261, 205, 0, 159, ...]
// columns.get('female') → [262, 207, 0, 159, ...]
```

## File Format (v1)

```
[Header 128B+]  magic, version, flags, zoom, CRS, origin, extent,
                bitmask_length, values_offset, index_hash (SHA-256), field schema
[Bitmask]       gzip-compressed 4-bit nibbles in BFS order
[Values]        row: raw entry_size × leaf_count (Range-requestable)
                columnar: column-by-column (varint + fixed types)
```

Full spec: [format-spec.md](docs/format-spec.md)

## API Reference

### Python (`pip install qbtiles`)

Also available as npm package for browser-side reading.

| Function | Description |
|----------|-------------|
| `build_quadtree(entries)` | Build quadtree from `(qk_int64, path, offset, length, run_length)` list |
| `serialize_bitmask(root)` | BFS serialize to `(bitmask_bytes, leaf_count)` |
| `write_qbt_fixed(path, bitmask, values, ...)` | Write fixed-entry row-mode QBT file |
| `write_qbt_columnar(path, bitmask, columns, ...)` | Write fixed-entry columnar QBT file |
| `write_qbt_variable(path, root, ...)` | Write variable-entry QBT file (tile archive) |
| `read_qbt_header(path_or_bytes)` | Parse QBT header to dict |
| `tile_to_quadkey_int64(z, x, y)` | Tile coords → 64-bit quadkey |
| `encode_custom_quadkey(x, y, zoom, ...)` | Custom CRS coord → quadkey |
| `decode_custom_quadkey(qk, zoom, ...)` | Quadkey → custom CRS center |
| `build_archive(folder, idx_path, data_path)` | Build tile archive from z/x/y folder |

### TypeScript/JavaScript (`npm install qbtiles`)

Also available as pip package for file creation.

| Function | Description |
|----------|-------------|
| `loadQBT(url, onProgress?)` | Fetch header + bitmask, hash-cached index |
| `parseQBTHeader(buffer)` | Parse QBT header from ArrayBuffer |
| `deserializeBitmaskIndex(buffer, zoom, ...)` | Build lazy tree index from bitmask |
| `queryBbox(index, bbox, grid)` | Spatial query → leaf indices |
| `mergeRanges(indices, maxGap, entrySize)` | Merge indices into byte ranges |
| `fetchRanges(url, ranges, ..., valuesOffset)` | Fetch values via Range Request |
| `readColumnarValues(buffer, header, leafCount)` | Decode columnar values (varint + fixed) |
| `clearIndexCache()` / `clearLeafCache()` | Clear client-side caches |
| `splitAntimeridian(bbox, latMin, latMax)` | Handle ±180° wrapping |
| `decodeCustomQuadkey(qk, zoom, ...)` | Custom CRS quadkey → coords |

## Live Demos

### [Tile Viewer](https://vuski.github.io/qbtiles/demo/tiles/) — Variable-entry (0x0)
MVT vector tiles served via QBTiles index + Range Request. Administrative boundaries of South Korea.

[![Tile Viewer](https://raw.githubusercontent.com/vuski/qbtiles/main/docs/image-tiles.png)](https://vuski.github.io/qbtiles/demo/tiles/)

### [Population Grid](https://vuski.github.io/qbtiles/demo/population/) — Fixed columnar (0x3)
931K cells in 1.75 MB. Korea 100m population grid with 3 values per cell at 1.97 Byte/cell.

[![Population Grid](https://raw.githubusercontent.com/vuski/qbtiles/main/docs/image-population.png)](https://vuski.github.io/qbtiles/demo/population/)

### [Range Request Comparison](https://vuski.github.io/qbtiles/demo/range-request/) — Fixed row (0x1)
Split-screen comparison: QBTiles cell-level vs COG block-level Range Request on WorldPop 1km global population.

https://raw.githubusercontent.com/vuski/qbtiles/main/docs/comparison.mp4

## Related Work

- **Sparse Voxel Octree (SVO)** — Same bitmask principle in 3D (8-bit masks for octree)
- **LOUDS** — Succinct tree encoding via BFS bit sequences
- **PMTiles** — Hilbert curve tile indexing with varint delta encoding

## License

MIT
