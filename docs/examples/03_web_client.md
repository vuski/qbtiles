# Example: Web Client

Three patterns for using the `qbtiles` npm package in the browser, each corresponding to a live demo.

- [Demo 1: Tile Archive Viewer](#1-tile-archive-viewer) — MVT tiles via custom protocol
- [Demo 2: Columnar Grid](#2-columnar-grid) — 930K population cells from 1.7 MB
- [Demo 3: Range Request](#3-range-request) — per-cell query on 51M cell dataset

Full source code: [demo-src/src/pages/](https://github.com/vuski/qbtiles/tree/main/demo-src/src/pages)

---

## 1. Tile Archive Viewer

Serve MVT vector tiles from a QBTiles archive using MapLibre's `addProtocol`. The index maps each tile's `(z, x, y)` to a byte range in the data file.

**Source**: [demo-src/src/pages/tiles/App.tsx](https://github.com/vuski/qbtiles/tree/main/demo-src/src/pages/tiles/App.tsx) · [Live demo](https://vuski.github.io/qbtiles/demo/tiles/)

### Install

```bash
npm install qbtiles
```

### Step 1: Create archive and load index

```typescript
import { QBTilesArchive } from 'qbtiles';

const archive = new QBTilesArchive('korea_tiles.qbt', 'korea_tiles.data');
await archive.load();
// archive.size → 36,149 entries
```

`QBTilesArchive` loads the `.qbt` file, parses the 128B header, decompresses the bitmask, and builds the tile index internally.

### Step 2: Fetch a tile

```typescript
const tileData = await archive.getTile(3, 4, 2);
// → ArrayBuffer (Range Request for exact bytes) or null
```

### Step 3: Register as MapLibre protocol

```typescript
archive.addProtocol(maplibregl, 'qbtiles');

map.addSource('qbtiles-vector', {
  type: 'vector',
  tiles: ['qbtiles:///{z}/{x}/{y}'],
  minzoom: 0,
  maxzoom: 14,
});
```

`addProtocol` registers a handler that parses `qbtiles:///{z}/{x}/{y}` URLs and fetches tile data via Range Request automatically.

**Key class**: `QBTilesArchive` (`load`, `getTile`, `getEntry`, `addProtocol`)

---

## 2. Columnar Grid

Load a `.qbt.gz` file containing 930K cells × 3 values (total, male, female population) in columnar layout with varint compression. The entire file is 1.7 MB.

**Source**: [demo-src/src/pages/population/App.tsx](https://github.com/vuski/qbtiles/tree/main/demo-src/src/pages/population/App.tsx) · [Live demo](https://vuski.github.io/qbtiles/demo/population/)

### Step 1: Download and decompress

```typescript
import { parseQBTHeader, deserializeBitmaskIndex, readColumnarValues } from 'qbtiles';

const res = await fetch('korea_pop_100m.qbt.gz');
const compressed = await res.arrayBuffer();

// Outer gzip: decompress the whole file
const ds = new DecompressionStream('gzip');
const writer = ds.writable.getWriter();
writer.write(new Uint8Array(compressed));
writer.close();
const buffer = await new Response(ds.readable).arrayBuffer();
```

### Step 2: Parse header

```typescript
const header = parseQBTHeader(buffer);
// header.zoom       → 13
// header.originX    → 686000  (EPSG:5179 meters)
// header.originY    → 1300000
// header.extentX    → 819200  (2^13 × 100m)
// header.fields     → [{name:'total', type:10}, {name:'male', type:10}, {name:'female', type:10}]
// header.isColumnar → true
```

The header contains CRS, origin, extent, zoom, and field schema. No hardcoded constants needed.

### Step 3: Decompress bitmask and build index

```typescript
// Bitmask section may be gzip-compressed inside the QBT file
const bitmaskBytes = new Uint8Array(buffer, header.headerSize, header.bitmaskLength);
let bitmaskBuf: ArrayBuffer;
if (bitmaskBytes[0] === 0x1f && bitmaskBytes[1] === 0x8b) {
  const ds2 = new DecompressionStream('gzip');
  const w2 = ds2.writable.getWriter();
  w2.write(bitmaskBytes);
  w2.close();
  bitmaskBuf = await new Response(ds2.readable).arrayBuffer();
} else {
  bitmaskBuf = bitmaskBytes.buffer.slice(
    header.headerSize, header.headerSize + header.bitmaskLength
  );
}

const index = await deserializeBitmaskIndex(bitmaskBuf, header.zoom, undefined, {
  bitmaskByteLength: bitmaskBuf.byteLength,
  bufferOffset: 0,
});
// index.totalLeaves → 931,495
```

### Step 4: Read columnar values

```typescript
const columns = readColumnarValues(buffer, header, index.totalLeaves);
const totals = columns.get('total')!;   // number[], length = 931,495
const males = columns.get('male')!;
const females = columns.get('female')!;
```

`readColumnarValues` reads each column according to the field schema. Varint columns are decoded automatically. Returns a `Map<string, number[]>` keyed by field name.

### Step 5: Convert leaf positions to coordinates

Each leaf's `(row, col)` can be recovered by walking the bitmask tree, then converted to geographic coordinates using the header's CRS parameters:

```typescript
const tileSize = header.extentX / (1 << header.zoom);

// For each leaf at (row, col):
const cx = header.originX + col * tileSize + tileSize / 2;  // cell center X
const cy = header.originY + row * tileSize + tileSize / 2;  // cell center Y
// → project to WGS84 using proj4 or similar
```

**Key functions**: `parseQBTHeader`, `deserializeBitmaskIndex`, `readColumnarValues`

---

## 3. Range Request

Query a subset of a 51M-cell global dataset by bounding box. Only the bitmask index is pre-downloaded (8.7 MB); cell values are fetched on demand via HTTP Range Request.

**Source**: [demo-src/src/pages/range-request/](https://github.com/vuski/qbtiles/tree/main/demo-src/src/pages/range-request) · [Live demo](https://vuski.github.io/qbtiles/demo/range-request/)

### Step 1: Load the QBT file header + bitmask

```typescript
import { loadQBT, queryBbox, mergeRanges, fetchRanges, queryResultToCells } from 'qbtiles';

const { header, index } = await loadQBT(
  'https://assets.example.com/global_pop.qbt',
  (msg) => console.log(msg),  // progress callback
);
// Fetches 128B header first, then bitmask via Range Request
// index_hash caching: same URL → reuses previously loaded bitmask
```

`loadQBT` fetches the 128-byte header, reads `bitmask_length`, then makes a second Range Request for the bitmask section only. The bitmask is cached by `index_hash`, so reloading the same dataset skips the download.

### Step 2: Query by bounding box

```typescript
const grid = {
  zoom: 16,
  originLon: -180, originLat: 84,
  pixelDeg: 360 / 43200,
  rasterCols: 43200, rasterRows: 17280,
};

const result = queryBbox(index, { west: 126, south: 35, east: 128, north: 37 }, grid);
// result.leafIndices → [234001, 234002, ...] (matching cell indices)
// result.rows, result.cols → pixel coordinates
```

`queryBbox` traverses the bitmask tree, finds all leaves within the bbox, and returns their indices plus `(row, col)` positions. No values are fetched yet.

### Step 3: Merge nearby cells and fetch

```typescript
const ranges = mergeRanges(result.leafIndices, 256, header.entrySize);
// Merges indices with gap ≤ 256 into contiguous byte ranges
// → fewer HTTP requests while maintaining per-cell precision

const { values, totalBytes, requestCount } = await fetchRanges(
  'https://assets.example.com/global_pop.qbt',
  ranges,
  undefined,  // AbortSignal
  undefined,  // onProgress
  header.valuesOffset,  // byte offset of value section within .qbt file
);
// values: Map<number, ArrayBuffer> keyed by leaf index
```

### Step 4: Convert to cell data

```typescript
const cells = queryResultToCells(result, values, ranges, grid);
// cells: Array<{ position: [lng, lat], value: number, chunkIndex: number }>
```

Each cell has its geographic `position` computed from `(row, col)` and the grid parameters.

**Key functions**: `loadQBT`, `queryBbox`, `mergeRanges`, `fetchRanges`, `queryResultToCells`, `queryResultToChunks`, `clearIndexCache`
