# API Reference

## Python (`pip install qbtiles`)

### QBT File I/O

#### `serialize_bitmask(root) → (bytes, int)`

BFS-traverse a quadtree and pack into bitmask bytes.

| Parameter | Type | Description |
|---|---|---|
| `root` | `QuadTreeNode` | Quadtree root node |
| **Returns** | `(bytes, int)` | `(bitmask_bytes, leaf_count)` |

#### `write_qbt_variable(output_path, root, ...)`

Create a variable-entry QBT file (tile archive index).

| Parameter | Type | Default | Description |
|---|---|---|---|
| `output_path` | `str` | | Output file path |
| `root` | `QuadTreeNode` | | Quadtree root |
| `data_path` | `str` | `None` | External data file path |
| `zoom` | `int` | `None` | Zoom level |
| `crs` | `int` | `4326` | EPSG code |
| `origin_x, origin_y` | `float` | `-180, 90` | Grid origin |
| `extent_x, extent_y` | `float` | `360, 180` | Grid extent |
| `metadata` | `str` | `None` | JSON metadata |

#### `write_qbt_fixed(output_path, bitmask_bytes, values_bytes, zoom, ...)`

Create a fixed-entry row mode QBT file. Values are stored row-interleaved for per-cell Range Request access.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `output_path` | `str` | | Output file path |
| `bitmask_bytes` | `bytes` | | From `serialize_bitmask()` |
| `values_bytes` | `bytes` | | `leaf_count × entry_size` bytes |
| `zoom` | `int` | | Zoom level |
| `crs` | `int` | `4326` | EPSG code |
| `origin_x, origin_y` | `float` | `0.0` | Grid origin |
| `extent_x, extent_y` | `float` | `0.0` | Grid extent |
| `entry_size` | `int` | `4` | Bytes per entry |
| `fields` | `list` | `None` | `[{'type': TYPE_FLOAT32, 'offset': 0, 'name': 'value'}]` |
| `metadata` | `str` | `None` | JSON metadata |
| `compress_bitmask` | `bool` | `True` | Gzip-compress bitmask section |

#### `write_qbt_columnar(output_path, bitmask_bytes, columns, leaf_count, zoom, ...)`

Create a fixed-entry columnar mode QBT file. Columns are stored sequentially, supporting mixed types including varint.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `output_path` | `str` | | Output file path |
| `bitmask_bytes` | `bytes` | | From `serialize_bitmask()` |
| `columns` | `list` | | `[(type_code, values_list), ...]` |
| `leaf_count` | `int` | | Number of leaves |
| `zoom` | `int` | | Zoom level |
| `fields` | `list` | `None` | `[{'type': TYPE_VARINT, 'offset': 0, 'name': 'total'}]` |
| `compress` | `bool` | `True` | Gzip whole file (.qbt.gz) |
| `compress_bitmask` | `bool` | `True` | Gzip bitmask section inside file |

#### `read_qbt_header(filepath_or_bytes) → dict`

Parse QBT file header. Accepts file path or bytes. Auto-decompresses gzip.

Returns dict with: `magic`, `version`, `header_size`, `flags`, `is_fixed`, `is_columnar`, `zoom`, `crs`, `origin_x`, `origin_y`, `extent_x`, `extent_y`, `bitmask_length`, `values_offset`, `values_length`, `metadata_offset`, `metadata_length`, `entry_size`, `field_count`, `index_hash`, `fields`.

### Tile Archive (Legacy)

#### `build_archive(folder, index_path, data_path, ext=".png")`

Build a QBTiles archive from a z/x/y tile folder. Creates `.idx.gz` index + `.data` file.

#### `load_index(index_path) → dict`

Load `.idx.gz` index file. Returns dict mapping `quadkey_int64 → entry`.

#### `get_tile(data_path, index, z, x, y) → bytes | None`

Retrieve a single tile's data by coordinates.

#### `index_tile_folder(folder, ext=".png") → list`

Scan z/x/y folder, return sorted list of `(quadkey_int64, filepath, offset, length, run_length)`.

### Quadtree Building

#### `build_quadtree(quadkey_info) → QuadTreeNode`

Build quadtree from list of `(quadkey_int64, path, offset, length, run_length)` tuples.

#### `insert_quadkey(quadkey_int64, offset, length, root, run_length)`

Insert a single quadkey entry into the tree.

### Quadkey Conversion

| Function | Description |
|---|---|
| `tile_to_quadkey(z, x, y) → str` | Tile coordinates → quadkey string |
| `quadkey_to_tile(qk) → (z, x, y)` | Quadkey string → tile coordinates |
| `tile_to_quadkey_int64(z, x, y) → int` | Tile coordinates → int64 with `0b11` prefix |
| `quadkey_int64_to_zxy(qint64) → (z, x, y)` | Int64 → tile coordinates |
| `quadkey_int64_to_str(qint64) → str` | Int64 → quadkey string |
| `quadkey_str_to_int64(qk) → int` | Quadkey string → int64 |

### Custom CRS

#### `encode_custom_quadkey(x, y, zoom, origin_x, origin_y, extent) → int`

Encode a coordinate in a custom CRS to quadkey int64.

#### `decode_custom_quadkey(qk_int64, zoom, origin_x, origin_y, extent) → (x, y)`

Decode quadkey int64 to center coordinate in custom CRS.

### Type Codes

| Constant | Value | Size |
|---|---|---|
| `TYPE_UINT8` | 1 | 1 byte |
| `TYPE_INT16` | 2 | 2 bytes |
| `TYPE_UINT16` | 3 | 2 bytes |
| `TYPE_INT32` | 4 | 4 bytes |
| `TYPE_UINT32` | 5 | 4 bytes |
| `TYPE_FLOAT32` | 6 | 4 bytes |
| `TYPE_FLOAT64` | 7 | 8 bytes |
| `TYPE_INT64` | 8 | 8 bytes |
| `TYPE_UINT64` | 9 | 8 bytes |
| `TYPE_VARINT` | 10 | variable |

---

## TypeScript (`npm install qbtiles`)

### QBT File Reader

#### `parseQBTHeader(buffer: ArrayBuffer): QBTHeader`

Parse a 128B+ QBT header from an ArrayBuffer.

```typescript
interface QBTHeader {
  magic: string;
  version: number;
  headerSize: number;
  flags: number;
  isFixed: boolean;
  isColumnar: boolean;
  zoom: number;
  crs: number;
  originX: number;
  originY: number;
  extentX: number;
  extentY: number;
  bitmaskLength: number;
  valuesOffset: number;
  valuesLength: number;
  metadataOffset: number;
  metadataLength: number;
  entrySize: number;
  fieldCount: number;
  indexHash: string;     // hex
  fields: QBTFieldDescriptor[];
}

interface QBTFieldDescriptor {
  type: number;
  offset: number;
  name: string;
}
```

#### `loadQBT(url, onProgress?, signal?): Promise<LoadResult>`

Fetch header (128B) → check index_hash cache → Range Request bitmask → deserialize.

| Parameter | Type | Description |
|---|---|---|
| `url` | `string` | QBT file URL |
| `onProgress` | `(msg: string) => void` | Progress callback |
| `signal` | `AbortSignal` | Abort signal |
| **Returns** | `LoadResult` | `{ header, index, indexBytes }` |

Caches bitmask by `index_hash`. Call `clearIndexCache()` to reset.

#### `readColumnarValues(buffer, header, leafCount): Map<string, number[]>`

Read columnar values from a decompressed QBT buffer. Decodes varint and fixed-type columns per field schema.

| Parameter | Type | Description |
|---|---|---|
| `buffer` | `ArrayBuffer` | Decompressed QBT file |
| `header` | `QBTHeader` | Parsed header |
| `leafCount` | `number` | From `index.totalLeaves` |
| **Returns** | `Map<string, number[]>` | Field name → values array |

#### `clearIndexCache(): void`

Clear the index_hash → BitmaskIndex cache.

### Bitmask Index

#### `deserializeBitmaskIndex(buffer, zoom, onProgress?, options?): Promise<BitmaskIndex>`

Build spatial index from bitmask bytes.

| Parameter | Type | Description |
|---|---|---|
| `buffer` | `ArrayBuffer` | Bitmask bytes |
| `zoom` | `number` | Leaf zoom level |
| `onProgress` | `(msg: string) => void` | Progress callback |
| `options` | `object` | `{ bitmaskByteLength?, bufferOffset? }` |

```typescript
interface BitmaskIndex {
  nibbles: Uint8Array;
  childStart: Uint32Array;
  subtreeLeaves: Uint32Array;
  totalLeaves: number;
  zoom: number;
}
```

#### `queryBbox(index, bbox, grid): QueryResult`

Find all leaf cells within a bounding box.

| Parameter | Type | Description |
|---|---|---|
| `index` | `BitmaskIndex` | From `deserializeBitmaskIndex` |
| `bbox` | `BBox` | `{ west, south, east, north }` |
| `grid` | `GridParams` | Grid parameters |
| **Returns** | `QueryResult` | `{ leafIndices, rows, cols }` |

#### `mergeRanges(indices, maxGap?, entrySize?): ByteRange[]`

Merge nearby leaf indices into contiguous byte ranges.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `indices` | `number[]` | | Sorted leaf indices |
| `maxGap` | `number` | `256` | Max gap to merge |
| `entrySize` | `number` | `4` | Bytes per entry |
| **Returns** | `ByteRange[]` | `[{ byteStart, byteEnd, leafIndices }]` |

#### `fetchRanges(url, ranges, signal?, onProgress?, valuesOffset?): Promise<...>`

Fetch cell values via HTTP Range Requests.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `url` | `string` | | Data file URL |
| `ranges` | `ByteRange[]` | | From `mergeRanges` |
| `signal` | `AbortSignal` | | Abort signal |
| `onProgress` | callback | | Per-request progress |
| `valuesOffset` | `number` | `0` | Byte offset of value section in file |
| **Returns** | object | | `{ values, totalBytes, requestCount, ... }` |

#### `queryResultToCells(result, values, ranges, grid): QBTCellData[]`

Convert query result + fetched values to cell data with coordinates.

```typescript
interface QBTCellData {
  position: [lng: number, lat: number];
  value: number;
  chunkIndex: number;
}
```

#### `queryResultToChunks(result, ranges, grid): QBTChunk[]`

Convert query result to chunk bounding boxes for visualization.

#### `clearLeafCache(): void`

Clear the per-cell value cache.

### Tile Archive (Legacy)

#### `deserializeQuadtreeIndex(buffer: ArrayBuffer): Map<bigint, QBTilesIndex>`

Deserialize a legacy `.idx.gz` index. Returns Map keyed by quadkey int64.

#### `tileToQuadkeyInt64(z, x, y): bigint`

Convert tile coordinates to int64 quadkey.

#### `quadkeyInt64ToZXY(qint64: bigint): { z, x, y }`

Convert int64 quadkey to tile coordinates.

### Spatial Utilities

| Function | Description |
|---|---|
| `splitAntimeridian(bbox) → BBox[]` | Split bbox crossing antimeridian into two |
| `bboxToRowColRange(bbox, ...) → object` | Convert bbox to pixel row/col range |
| `lonToCol(lon, originLon, pixelDeg) → number` | Longitude to column index |
| `latToRow(lat, originLat, pixelDeg) → number` | Latitude to row index |
| `colToLon(col, originLon, pixelDeg) → number` | Column index to longitude |
| `rowToLat(row, originLat, pixelDeg) → number` | Row index to latitude |

### Custom CRS

#### `decodeCustomQuadkey(qkInt64, zoom, originX, originY, extent): [x, y]`

Decode quadkey int64 to center coordinate in custom CRS.

### Types

```typescript
type BBox = { west: number; south: number; east: number; north: number };

interface GridParams {
  zoom: number;
  originLon: number;
  originLat: number;
  pixelDeg: number;
  rasterCols: number;
  rasterRows: number;
}
```
