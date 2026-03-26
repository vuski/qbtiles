# QBTiles

**QBTiles** (Quadkey Bitmask Tiles) is a spatial data format that encodes existence as a tree structure, reducing ID storage cost to zero.

It stores tile/cell existence as **4-bit bitmasks** in BFS order. The position of each entry is implied by the tree structure — **no IDs, no coordinates stored**.

## Why QBTiles?

- **Smaller file, finer access**: 20–30% smaller index than PMTiles, per-cell Range Request vs COG's 512×512 blocks. [See comparison →](data-container.md)
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

### Python — Build QBT Files

```python
import qbtiles as qbt

# Mode 1: Tile archive — from a folder of z/x/y tiles (e.g., tiles/5/27/12.mvt)
qbt.build("korea_tiles.qbt", folder="tiles/")

# Mode 2: Columnar — coordinates + multiple value columns
# coords: list of (x, y) in the target CRS
# columns: dict of column_name → value list (same length as coords)
# cell_size: grid cell size in CRS units (meters for EPSG:5179)
# → zoom, origin, extent are auto-calculated from coords and cell_size
qbt.build("population.qbt.gz",
    coords=list(zip(df["x"], df["y"])),         # [(950000, 1950000), ...]
    columns={"total": totals, "male": males, "female": females},
    cell_size=100, crs=5179)                     # 100m grid, Korean CRS

# Mode 3: Fixed row — coordinates + single value array (for Range Request)
# values: flat list of numbers (one per cell)
# entry_size: bytes per cell (4 for float32)
qbt.build("global_pop.qbt",
    coords=list(zip(lons, lats)),                # [(-73.99, 40.75), ...]
    values=population,                           # [52.3, 41.2, ...]
    cell_size=1000, entry_size=4,                # 1km grid, 4 bytes/cell
    fields=[{"type": qbt.TYPE_FLOAT32, "name": "pop"}])

# GeoTIFF → QBTiles conversion (cell_size, CRS, extent auto-detected)
qbt.build("worldpop.qbt", geotiff="worldpop_2025.tif")
```

### TypeScript — Read & Query

```typescript
import { openQBT } from 'qbtiles';

// openQBT reads the header, detects the mode, and loads data automatically.

// Mode 1: Tile archive — serve MVT/PNG tiles from a single .qbt file
const tiles = await openQBT('korea_tiles.qbt');
const tile = await tiles.getTile(7, 109, 49);  // ArrayBuffer (gzip MVT) | null
tiles.addProtocol(maplibregl, 'qbt');           // one-line MapLibre integration

// Mode 3: Fixed row — per-cell Range Request on a remote file
const grid = await openQBT('https://cdn.example.com/global_pop.qbt');
const cells = await grid.query([126, 35, 128, 37]);  // [west, south, east, north]
// → Array<{ position: [lng, lat], value: number }>

// Mode 2: Columnar — downloads entire file, queries in memory
const pop = await openQBT('population.qbt.gz');
pop.columns!.get('total')!;                     // number[931495] — direct access
const result = await pop.query([126, 35, 128, 37]);
// → Array<{ position: [lng, lat], values: {total: 523, male: 261, female: 262} }>
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
  python/qbtiles.py          — Python library: build(), quadtree, QBT write/read
  typescript/qbtiles.ts      — TypeScript entry point: re-exports all modules
  typescript/qbt.ts          — Unified reader: QBT class, openQBT(), registerCRS()
  typescript/qbt-header.ts   — Header parser (parseQBTHeader)
  typescript/qbt-reader.ts   — Low-level reader (loadQBTVariable, loadQBTColumnar)
  typescript/bitmask-index.ts — Lazy tree index, spatial query, Range Request
  typescript/types.ts        — Shared types (BBox, GridParams, coord utils)
  cpp/                       — Native Hilbert→quadkey encoder (pybind11, optional)
demo-src/                    — Vite + React demo source (3 pages + landing)
docs/                        — MkDocs documentation site source
examples/                    — Sample data files (.qbt, .qbt.gz, .pmtiles)
dist/                        — npm build output (ESM + CJS + .d.ts)
```

## License

MIT
