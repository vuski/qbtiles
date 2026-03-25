# QBTiles

**QBTiles** (Quadkey Bitmask Tiles) is a spatial data format that encodes existence as a tree structure, reducing ID storage cost to zero.

It stores tile/cell existence as **4-bit bitmasks** in BFS order. The position of each entry is implied by the tree structure — **no IDs, no coordinates stored**.

## Why QBTiles?

- **Smaller file, finer access**: 30% smaller index than PMTiles, per-cell Range Request vs COG's 512×512 blocks. [See comparison →](data-container.md)
- **Zero cost for empty space**: Bitmask tree stores only existing cells — no wasted bytes on nodata
- **Three modes**: Tile archives (variable-entry), raster grids (fixed row), compressed grids (fixed columnar)
- **Index hash**: SHA-256 enables index reuse across time-series files with identical spatial structure
- **Cloud-native**: HTTP Range Request for serverless serving (S3, R2, etc.)

## Install

```bash
pip install qbtiles    # Python — build & write QBT files
npm install qbtiles    # TypeScript — read & query in the browser
```

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

## Three Modes

| Mode | Flags | Use Case | Comparable to |
|------|-------|----------|---------------|
| **Variable-entry** | `0x0` | Tile archives (MVT, PNG) | PMTiles |
| **Fixed row** | `0x1` | Raster grids | COG (GeoTIFF) |
| **Fixed columnar** | `0x3` | Compressed grids | Parquet |

## Project Structure

```
src/
  python/qbtiles.py          — Python library: quadtree build, QBT write/read
  typescript/qbtiles.ts      — TypeScript library: re-exports all modules
  typescript/qbt-header.ts   — Header parser (parseQBTHeader)
  typescript/qbt-reader.ts   — High-level reader (loadQBT, readColumnarValues)
  typescript/bitmask-index.ts — Lazy tree index, spatial query, Range Request
  typescript/bitmask-values.ts — Legacy adaptive bit-width decoder
  typescript/custom-crs.ts   — Custom CRS quadkey decoder
  typescript/types.ts        — Shared types (BBox, GridParams, coord utils)
  cpp/                       — Native Hilbert→quadkey encoder (pybind11, optional)
demo-src/                    — Vite + React demo source (3 pages + landing)
docs/                        — MkDocs documentation site source
examples/                    — Sample data files (.qbt, .qbt.gz, .pmtiles)
dist/                        — npm build output (ESM + CJS + .d.ts)
```

## License

MIT
