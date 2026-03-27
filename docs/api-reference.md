# API Reference

<style>
table td, table th { padding: 4px 8px; font-size: 14px; }
table code { font-size: 13px; }
</style>

## Python — Writer (`pip install qbtiles`)

### `qbt.build()`

```python
import qbtiles as qbt
qbt.build(output_path, ...)
```

One function, three modes. The mode is determined by which argument you pass: `folder`, `columns`, or `values`.

---

#### Mode 1: Variable-entry — Tile Archive

PMTiles replacement. Packs a z/x/y tile folder into a single `.qbt` file for serving via Range Request. Each tile is individually addressable by z/x/y.

```python
qbt.build("korea.qbt", folder="tiles/")
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `output_path` | `str` | *required* | Output `.qbt` file |
| `folder` | `str` | *required* | Tile folder. Must contain `{z}/{x}/{y}.{ext}` structure (e.g. `5/17/11.png`) |
| `ext` | `str` | `".png"` | File extension to match. `.png`, `.pbf`, `.mvt`, `.webp` etc. |

All zoom levels found in the folder are included. Tiles are concatenated in quadkey order. For MVT/PBF tiles, `vector_layers` and `data_bounds` are automatically recorded in metadata.

```python
# MVT vector tiles
qbt.build("osm.qbt", folder="mvt_tiles/", ext=".pbf")

# WebP raster tiles
qbt.build("satellite.qbt", folder="webp_tiles/", ext=".webp")
```

---

#### Mode 2: Columnar — Bulk Grid Data

For irregular grid data small enough to download entirely (e.g. national census). Supports multiple attributes per cell. Varint compression makes integer data extremely compact.

Coordinates are snapped to grid cells of `cell_size`. If multiple points fall in the same cell, numeric columns are **summed** automatically (with a warning). Non-numeric columns are not supported. This means you can pass raw point data — it will be aggregated into a grid.

```python
# Minimal — cell_size + crs only. origin/extent/zoom auto-calculated from coords.
qbt.build("population.qbt.gz",
    coords=list(zip(df["x"], df["y"])),
    columns={"total": df["total"].tolist(), "male": df["male"].tolist()},
    cell_size=100, crs=5179)

# Multi-band GeoTIFF → columnar (each band becomes a column)
qbt.build("landcover.qbt.gz", geotiff="classification.tif")

# Explicit — if you need a specific grid origin/extent
qbt.build("population.qbt.gz",
    coords=list(zip(df["x"], df["y"])),
    columns={"total": df["total"].tolist(), "male": df["male"].tolist()},
    cell_size=100, crs=5179,
    origin_x=700000, origin_y=1300000, extent_x=819200, extent_y=819200)
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `output_path` | `str` | *required* | Output `.qbt.gz` file (gzip-compressed) |
| `coords` | `list[(x,y)]` | — | Cell center coordinates in the file's CRS |
| `columns` | `dict[str, list]` | — | `{"name": [values]}`. All-int → varint; float → float32 |

Grid parameters:

| Parameter | Type | Default | Description |
|---|---|---|---|
| `cell_size` | `float` | `None` | Cell size in CRS units (e.g. `100` for 100m). Recommended over `zoom` |
| `crs` | `int` | `4326` | EPSG code |
| `origin_x` | `float` | auto | Grid origin X. **Auto-calculated from coords** for custom CRS |
| `origin_y` | `float` | auto | Grid origin Y. Auto-calculated from coords |
| `extent_x` | `float` | auto | Grid width = `cell_size × 2^zoom`. Auto-calculated (always square) |
| `extent_y` | `float` | auto | Grid height = extent_x |
| `zoom` | `int` | auto | `log2(extent / cell_size)`. Auto-calculated from `cell_size` |

For custom CRS (crs ≠ 4326): only `cell_size` and `crs` are needed. Origin, extent, zoom are auto-calculated from coords to fit a square grid that contains all data points.

For EPSG:4326: defaults are global (origin=-180,90, extent=360×180). Override if needed.

---

#### Mode 3: Fixed Row — Range Request Grid

COG (GeoTIFF) replacement for sparse grids. Each cell has a fixed-size value. Cells are individually accessible via HTTP Range Request without downloading the whole file.

Same snapping and aggregation behavior as columnar mode — coordinates are snapped to `cell_size`, duplicates are summed.

```python
# Convert directly from GeoTIFF — everything auto-detected
# Requires: pip install rasterio numpy
qbt.build("worldpop.qbt", geotiff="worldpop.tif")

# Or build manually from coordinates + values
qbt.build("worldpop.qbt",
    coords=list(zip(lons, lats)), values=population,
    cell_size=1/120, entry_size=4,
    fields=[{"type": qbt.TYPE_FLOAT32, "name": "population"}])
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `output_path` | `str` | *required* | Output `.qbt` file (not gzipped — values must be uncompressed for Range Request) |
| `coords` | `list[(x,y)]` | — | Cell center coordinates in the file's CRS |
| `values` | `list\|bytes` | — | Values per cell. `list` → packed per `fields` type; `bytes` → raw |
| `entry_size` | `int` | `4` | Bytes per cell (e.g. 4 for float32, 8 for float64) |
| `fields` | `list[dict]` | `None` | `[{"type": TYPE_FLOAT32, "name": "pop"}]` |
| `geotiff` | `str` | `None` | GeoTIFF path. All other params auto-detected (cell_size, CRS, origin, extent, nodata). Requires `rasterio`, `numpy` |
| `nodata` | `number` | `None` | Override nodata value (skips cells with this value). If not set, uses the GeoTIFF's built-in nodata |
| `bitmask_only` | `bool` | `False` | Store only cell existence — no values section. `entry_size=0`. Useful for binary masks (land/water, coverage) |

Grid parameters (`cell_size`/`zoom`, `crs`, `origin_*`, `extent_*`) are the same as columnar mode.

**Bitmask-only**: When `bitmask_only=True`, only the bitmask is stored (no values section). The file is a valid fixed-row QBT with `entry_size=0` and `values_length=0`. On the reader side, `query()` returns all matching cells with `value=1`. This is ideal for binary presence/absence data where the existence itself is the information.

```python
# Binary mask from GeoTIFF (e.g. land=1, water=0 with nodata=0)
qbt.build("landmask.qbt", geotiff="landmask.tif", nodata=0, bitmask_only=True)

# From coordinates — just store which cells exist
qbt.build("coverage.qbt", coords=points, values=[1]*len(points),
    cell_size=1000, bitmask_only=True)
```

```python
# Custom CRS — origin/extent auto-calculated
qbt.build("sensor.qbt",
    coords=list(zip(xs, ys)), values=measurements,
    cell_size=500, crs=32652, entry_size=4,
    fields=[{"type": qbt.TYPE_FLOAT32, "name": "temperature"}])
```

---

#### Common: `quadkeys` instead of `coords`

For both columnar and fixed row, you can pass pre-computed quadkeys instead of coordinates:

```python
qbt.build("out.qbt.gz",
    quadkeys=[244021529, 244021531, ...],  # quadkey int64 list
    columns={"pop": [100, 200, ...]},
    zoom=13, crs=5179, origin_x=700000, origin_y=1300000, extent_x=819200, extent_y=819200)
```

### Low-level Functions

For advanced use. Most users only need `build()`.

| Function | Description |
|---|---|
| `read_qbt_header(path_or_bytes) → dict` | Parse QBT header. Auto-detects gzip |
| `deserialize_quadtree_index(path_or_bytes) → list[dict]` | Restore entries from variable-entry index |
| `write_qbt_variable(path, root, tile_entries?, ...)` | Variable-entry single file |
| `write_qbt_fixed(path, bitmask_bytes, values_bytes, ...)` | Fixed row file |
| `write_qbt_columnar(path, bitmask_bytes, columns, leaf_count, ...)` | Columnar file |
| `serialize_bitmask(root) → (bytes, leaf_count)` | BFS quadtree → bitmask bytes |
| `build_quadtree(quadkey_info) → QuadTreeNode` | Build tree from `[(qk, path, offset, length, rl)]` |
| `index_tile_folder(folder, ext) → list` | Scan z/x/y folder → sorted entry list |

### Quadkey Conversion

| Function | Description |
|---|---|
| `tile_to_quadkey_int64(z, x, y) → int` | Tile coords → quadkey int64 with `0b11` prefix |
| `quadkey_int64_to_zxy(qint64) → (z, x, y)` | Quadkey int64 → tile coords |
| `encode_custom_quadkey(x, y, zoom, origin_x, origin_y, extent) → int` | Custom CRS coord → quadkey |
| `decode_custom_quadkey(qint64, zoom, origin_x, origin_y, extent) → (x, y)` | Quadkey → custom CRS cell center |
| `tile_to_quadkey(z, x, y) → str` | Tile coords → quadkey string (`"0213"`) |
| `quadkey_to_zxy(qk) → (z, x, y)` | Quadkey string → tile coords |

### Type Constants

| Constant | Value | Size | Constant | Value | Size |
|---|---|---|---|---|---|
| `TYPE_UINT8` | 1 | 1B | `TYPE_FLOAT32` | 6 | 4B |
| `TYPE_INT16` | 2 | 2B | `TYPE_FLOAT64` | 7 | 8B |
| `TYPE_UINT16` | 3 | 2B | `TYPE_INT64` | 8 | 8B |
| `TYPE_INT32` | 4 | 4B | `TYPE_UINT64` | 9 | 8B |
| `TYPE_UINT32` | 5 | 4B | `TYPE_VARINT` | 10 | variable (columnar only) |

---

## TypeScript — Reader (`npm install qbtiles`)

### `openQBT()`

```typescript
const qbt = await openQBT(url: string, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<QBT>
```

| Parameter | Type | Description |
|---|---|---|
| `url` | `string` | URL to `.qbt` or `.qbt.gz` file. `.qbt.gz` → full download; `.qbt` → Range Request for header first |
| `onProgress` | `(msg) => void` | Progress callback (downloading, decompressing, building index, ...) |
| `signal` | `AbortSignal` | Cancellation signal |

Opens a QBT file. Reads header, detects mode from flags, loads index/data automatically. Returns `QBT` instance.

```typescript
// Tile archive → serve via MapLibre
const tiles = await openQBT('korea_tiles.qbt');
tiles.addProtocol(maplibregl);
map.addSource('src', { type: 'vector', tiles: ['qbtiles:///{z}/{x}/{y}'] });

// Columnar grid → full download, access columns directly
const pop = await openQBT('population.qbt.gz');
const totals = pop.columns!.get('total')!;  // number[931495]

// Fixed row → per-cell Range Request on 51M cell dataset
const world = await openQBT('worldpop.qbt');
const cells = await world.query([126, 35, 128, 37]);
// cells fetched via HTTP Range Request, not full download
```

### `QBT` — Properties

| Property | Type | Description |
|---|---|---|
| `header` | `QBTHeader` | Parsed 128B header (zoom, crs, origin, extent, fields, ...) |
| `mode` | `'variable'\|'fixed'\|'columnar'` | Detected from flags: `0x0`→variable, `0x1`→fixed, `0x3`→columnar |
| `leafCount` | `number` | Tile count (variable) or cell count (fixed/columnar) |
| `columns` | `Map<string, number[]>\|null` | Column values. Only available in columnar mode |
| `metadata` | `Record<string, any>\|null` | Parsed JSON from metadata section. May contain `data_bounds`, `vector_layers` |
| `lastStats` | `QBTQueryStats\|null` | `{ requests, bytes, cells, timeMs }` from last `query()` |

### `QBT` — Methods

#### `qbt.getTile(z, x, y, signal?)`

```typescript
const tile: ArrayBuffer | null = await qbt.getTile(z, x, y, signal?)
```

| Parameter | Type | Description |
|---|---|---|
| `z, x, y` | `number` | Tile coordinates |
| `signal` | `AbortSignal` | Cancellation signal |

Fetches a single tile via Range Request. Returns `null` if not found. **Variable mode only.**

```typescript
const tile = await qbt.getTile(7, 109, 49);
// tile: ArrayBuffer (gzip-compressed MVT, PNG, etc.)
```

#### `qbt.query(bbox, zoom?, signal?, onProgress?)`

```typescript
const cells: QBTCellData[] = await qbt.query(bbox, zoom?, signal?, onProgress?)
```

| Parameter | Type | Description |
|---|---|---|
| `bbox` | `BBox` | `[west, south, east, north]` in WGS84. Auto-converted to native CRS internally |
| `zoom` | `number` | Target zoom level (variable mode — which zoom's tiles to query) |
| `signal` | `AbortSignal` | Cancellation signal |
| `onProgress` | callback | Per-request progress |

Returns `QBTCellData[]` — `{ position: [lng, lat], value, chunkIndex }`. Works in all modes:

| Mode | Mechanism | Notes |
|---|---|---|
| variable | Range Request per tile in bbox at given zoom | `zoom` required |
| fixed | Range Request for matching cells | `mergeRanges` applied automatically |
| columnar | Memory lookup (already downloaded) | Instant, no network |

```typescript
const cells = await qbt.query([126, 35, 128, 37]);
// cells[0].position → [127.5, 36.2]
// cells[0].value    → first column value (all modes)
// cells[0].values   → { total: 100, male: 50, female: 50 } (columnar mode)
```

#### `qbt.addProtocol(maplibregl, protocol?)`

```typescript
qbt.addProtocol(maplibregl, protocol?)
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `maplibregl` | `any` | *required* | MapLibre GL JS module |
| `protocol` | `string` | `'qbtiles'` | Custom protocol name |

Registers a custom protocol handler. **Variable mode only.** Gzip-compressed tiles are automatically decompressed. After calling, use `protocol:///{z}/{x}/{y}` in tile sources.

```typescript
qbt.addProtocol(maplibregl, 'qbt');
map.addSource('tiles', { type: 'vector', tiles: ['qbt:///{z}/{x}/{y}'] });
```

#### `qbt.getCellBBox(z, x, y)` / `qbt.toWGS84(x, y)` / `qbt.fromWGS84(lng, lat)`

| Method | Returns | Description |
|---|---|---|
| `getCellBBox(z, x, y)` | `BBox` | Cell/tile bounds in WGS84 |
| `toWGS84(x, y)` | `[lng, lat]` | Native CRS → WGS84 (uses proj4 internally) |
| `fromWGS84(lng, lat)` | `[x, y]` | WGS84 → native CRS |
| `getEntry(z, x, y)` | `VariableEntry\|undefined` | Lookup tile entry without fetching (variable only) |

```typescript
const [lng, lat] = qbt.toWGS84(950000, 1950000);  // EPSG:5179 → WGS84
```

### `registerCRS()`

```typescript
registerCRS(epsg: number, proj4Def: string): void
```

Register a custom CRS definition. Call before `openQBT()` if your file uses a CRS not in the built-in list.

Built-in: EPSG:4326, 3857, 5179, 5186, 5187, 32652.

```typescript
registerCRS(32633, '+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs');
const qbt = await openQBT('data_utm33.qbt');
```

### Mapping Library Integration

**MapLibre GL JS**
```typescript
qbt.addProtocol(maplibregl, 'qbt');
map.addSource('src', { type: 'vector', tiles: ['qbt:///{z}/{x}/{y}'] });
```

**deck.gl TileLayer** (standalone, without MapLibre)
```typescript
new TileLayer({
  getTileData: ({index, signal}) => qbt.getTile(index.z, index.x, index.y, signal)
});
```

**Leaflet GridLayer**
```typescript
createTile(coords, done) {
  qbt.getTile(coords.z, coords.x, coords.y)
    .then(buf => { done(null, renderToCanvas(buf)); });
  return document.createElement('canvas');
}
```

**OpenLayers**
```typescript
new VectorTile({ loader: (z, x, y) => qbt.getTile(z, x, y) });
```

### Types

| Type | Definition |
|---|---|
| `BBox` | `[west, south, east, north]` — WGS84 degrees |
| `QBTHeader` | `{ magic, version, headerSize, flags, isFixed, isColumnar, zoom, crs, originX, originY, extentX, extentY, bitmaskLength, valuesOffset, valuesLength, entrySize, fieldCount, indexHash, fields }` |
| `QBTFieldDescriptor` | `{ type: number, offset: number, name: string }` |
| `QBTCellData` | `{ position: [lng, lat], value: number, chunkIndex: number, values?: Record<string, number> }` |
| `QBTMode` | `'variable' \| 'fixed' \| 'columnar'` |
| `QBTQueryStats` | `{ requests: number, bytes: number, cells: number, timeMs: number }` |
| `GridParams` | `{ zoom, originLon, originLat, pixelDeg, rasterCols, rasterRows }` |

### Low-level Functions

For advanced use. Most users only need `openQBT`.

| Function | Signature | Description |
|---|---|---|
| `parseQBTHeader` | `(buffer) → QBTHeader` | Parse 128B+ header |
| `deserializeBitmaskIndex` | `(buffer, zoom, onProgress?, options?) → Promise<BitmaskIndex>` | Build spatial index from bitmask |
| `deserializeQuadtreeIndex` | `(buffer) → Map<bigint, QBTilesIndex>` | Deserialize variable-entry index |
| `readColumnarValues` | `(buffer, header, leafCount) → Map<string, number[]>` | Read columnar values |
| `queryBbox` | `(index, bbox, grid) → QueryResult` | Find leaves in bbox |
| `mergeRanges` | `(indices, maxGap?, entrySize?) → ByteRange[]` | Merge nearby indices |
| `fetchRanges` | `(url, ranges, signal?, onProgress?, valuesOffset?) → Promise<...>` | Fetch via Range Request |
| `queryResultToCells` | `(result, values, ranges, grid) → QBTCellData[]` | Convert to cell data |
| `splitAntimeridian` | `(bbox) → BBox[]` | Split bbox crossing antimeridian |
| `tileToQuadkeyInt64` | `(z, x, y) → bigint` | Tile → quadkey int64 |
| `quadkeyInt64ToZXY` | `(qint64) → { z, x, y }` | Quadkey int64 → tile |
| `decodeCustomQuadkey` | `(qkInt64, zoom, originX, originY, extent) → [x, y]` | Quadkey → CRS center |

**Type Constants**: Same as Python — `TYPE_UINT8`(1) through `TYPE_VARINT`(10).
