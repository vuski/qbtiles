# QBTiles v1.0 Binary Format Specification

## Overview

QBTiles v1.0 is a unified binary format for spatially-indexed data. It supports two modes:

- **Variable-entry mode** (`entry_size = 0`): Each entry has a different size. Includes offset/length arrays. For tile archives (MVT, PNG, etc.) — replaces PMTiles.
- **Fixed-entry mode** (`entry_size > 0`): All entries have the same byte size. No offset/length arrays needed. For raster grids, fixed-size records — replaces GeoTIFF for sparse data.

Both modes share the same header, bitmask structure, and spatial indexing. A single parser handles both.

## File Structure

```
[Header]              Fixed-size, ≥128 bytes
[Bitmask Section]     4-bit child masks, BFS order
[Varint Section]      Variable mode only: run_lengths[], lengths[], offsets[]
[Values Section]      Fixed mode only: entry_size × leaf_count bytes
[Metadata Section]    Optional JSON
```

## 1. Header

All multi-byte integers are **little-endian** unless noted.

```
Offset  Size  Type      Field              Description
──────  ────  ────────  ─────────────────  ─────────────────────────────────────
0       4     char[4]   magic              "QBT\x01" (0x51 0x42 0x54 0x01)
4       2     uint16    version            1 (current)
6       2     uint16    header_size        Total header bytes (≥128). Bitmask starts at this offset.
8       4     uint32    flags              Bit 0: 0=variable, 1=fixed entry mode
                                           Bit 1: 0=row layout, 1=columnar layout
                                           Bits 2–31: reserved (must be 0)
12      1     uint8     zoom               Quadtree depth (leaf zoom level)
13      1     uint8     reserved           Must be 0
14      2     uint16    crs                EPSG code. 0 = custom CRS (use origin/extent).
                                           4326 = WGS84 lon/lat.
16      8     float64   origin_x           X coordinate of grid origin (left edge)
24      8     float64   origin_y           Y coordinate of grid origin (top edge)
32      8     float64   extent_x           Grid extent in X direction
40      8     float64   extent_y           Grid extent in Y direction (positive downward)
48      8     uint64    bitmask_length     Byte length of bitmask section
56      8     uint64    values_offset      Byte offset of values section (fixed mode)
64      8     uint64    values_length      Byte length of values section
72      8     uint64    metadata_offset    Byte offset of JSON metadata (0 = none)
80      8     uint64    metadata_length    Byte length of JSON metadata
88      4     uint32    entry_size         Bytes per entry. 0 = variable mode.
92      2     uint16    field_count        Number of fields in schema (fixed mode)
94      32    bytes     index_hash         SHA-256 of bitmask section (header_size to values_offset).
                                           All zeros if not computed.
126     2     bytes     reserved           Must be 0. Future use.
──────  ────
128            MINIMUM HEADER SIZE
```

### Field Schema (fixed mode only)

Immediately after byte 128, `field_count` field descriptors:

```
Offset  Size  Type      Field              Description
──────  ────  ────────  ─────────────────  ─────────────────────────────────────
0       1     uint8     type               Type code (see below)
1       1     uint8     offset             Byte offset within entry
2       2     uint16    name_length        Length of field name in bytes
4       var   char[]    name               UTF-8 field name (not null-terminated)
```

Field descriptors are packed sequentially with no padding between them.

**Type codes:**

| Code | Type    | Size   |
|------|---------|--------|
| 1    | uint8   | 1      |
| 2    | int16   | 2      |
| 3    | uint16  | 2      |
| 4    | int32   | 4      |
| 5    | uint32  | 4      |
| 6    | float32 | 4      |
| 7    | float64 | 8      |
| 8    | int64   | 8      |
| 9    | uint64  | 8      |
| 10   | varint  | variable | Unsigned LEB128. Columnar mode only. |

**Row layout** (flags bit 1 = 0): `entry_size` must equal the sum of all field sizes. Only fixed-size types (1–9) allowed. Parsers should validate this.

**Columnar layout** (flags bit 1 = 1): `entry_size` is 0. Variable-length types (varint) are allowed. The `offset` field in each descriptor is ignored (columns are stored sequentially).

### Header Extensibility

`header_size` may exceed 128 + field schema bytes. Parsers must skip to `header_size` to find the bitmask section. Unknown bytes between the field schema and `header_size` are ignored, ensuring forward compatibility.

## 2. Magic Bytes

```
Bytes 0–3 = "QBT\x01" (0x51 0x42 0x54 0x01)
```

Parsers must verify magic bytes before processing.

## 3. Bitmask Section

Starts at byte offset `header_size`. Encodes the quadtree in **BFS (breadth-first) order**.

### Bitmask Encoding

Each node has a 4-bit child-presence mask:

```
Bit position:  [3] [2] [1] [0]
Child number:   0   1   2   3
Quadkey digit:  0   1   2   3
```

- Bit set → child exists (descend further or leaf)
- Bit clear → child absent (no data in that quadrant)

### Quadkey Digit Mapping

```
digit 0 = top-left      (row bit 0, col bit 0)
digit 1 = top-right     (row bit 0, col bit 1)
digit 2 = bottom-left   (row bit 1, col bit 0)
digit 3 = bottom-right  (row bit 1, col bit 1)
```

### Byte Packing

Two 4-bit bitmasks per byte, high nibble first:

```
byte = (first_bitmask << 4) | second_bitmask
```

If the total node count is odd, the last byte's low nibble is 0. During deserialization, a trailing 0 nibble is removed.

### BFS Traversal

```
Level 0 (root):   [root bitmask]
Level 1:          [child0 bitmask] [child1 bitmask] ...
Level 2:          [grandchild bitmasks...]
...
Level zoom-1:     [parent-of-leaf bitmasks]
```

Traversal terminates when reaching zoom depth (leaf level). Leaf nodes have no bitmask entry — they are the data entries.

### Quadkey Reconstruction

No tile IDs are stored. Quadkeys are reconstructed by expanding the BFS tree:

```
root = 0b11 (prefix)
for each node's bitmask:
    for each set bit i (0..3):
        child_quadkey = (parent_quadkey << 2) | i
```

The number of leaves encountered in BFS order determines the leaf index (0-based), which maps directly to the values section.

## 4. Values Section (Fixed-Entry Mode)

### 4a. Row Layout (flags bit 1 = 0)

When `entry_size > 0`, the values section contains `leaf_count × entry_size` bytes at offset `values_offset`.

Leaf `i` occupies bytes `[values_offset + i × entry_size, values_offset + (i+1) × entry_size)`.

**This is the key property enabling per-cell Range Requests**: given only the bitmask (which can be downloaded separately), a client computes `leaf_index` for any spatial query, then fetches exactly `entry_size` bytes via:

```
Range: bytes={values_offset + leaf_index * entry_size}-{values_offset + (leaf_index + 1) * entry_size - 1}
```

The values section is **not compressed**, enabling direct Range Request access.

**Multi-field example** (row layout):

```
entry_size: 6
fields: [
    { type: uint16, offset: 0, name: "total" },
    { type: uint16, offset: 2, name: "male" },
    { type: uint16, offset: 4, name: "female" },
]

Values: [total₀|male₀|female₀][total₁|male₁|female₁]...
```

Each leaf's 6 bytes contain all three values contiguously.

### 4b. Columnar Layout (flags bit 1 = 1)

Values are stored column-by-column in field schema order. `entry_size` is 0 (not applicable).

```
[column 0: leaf_count values] [column 1: leaf_count values] ...
```

- **Fixed-size types** (uint8–uint64, float32/64): `leaf_count × type_size` bytes, little-endian.
- **Varint** (type 10): `leaf_count` unsigned LEB128 values, sequentially packed.

**Example** (columnar layout, varint):

```
entry_size: 0
fields: [
    { type: varint, offset: 0, name: "total" },
    { type: varint, offset: 0, name: "male" },
    { type: varint, offset: 0, name: "female" },
]

Values: [total₀ total₁ total₂ ...][male₀ male₁ ...][female₀ female₁ ...]
         (varint, variable bytes)   (varint)          (varint)
```

Columnar layout is optimized for bulk download with compression (gzip). Same-type values cluster together, producing better compression ratios than row layout. Per-cell Range Requests are **not supported** in columnar mode.

## 5. Varint Section (Variable-Entry Mode)

When `entry_size = 0`, the varint section follows the bitmask section. Three varint arrays stored column-wise:

```
[run_lengths array] [lengths array] [offsets array]
```

Each array has `node_count` elements (= number of BFS-traversed nodes including internal nodes).

### run_lengths[]

Each node's run_length value. Varint encoded.

### lengths[]

Each node's data byte length. Varint encoded. Nodes with `length == 0` are internal (no data).

### offsets[] (Delta Encoding)

Each node's byte offset in the external data file:

- Contiguous entries (`offset[i] == offset[i-1] + length[i-1]`): write `0`
- Non-contiguous: write `offset[i] + 1`

### Data File Access

Use offset and length for HTTP Range Requests against a separate data file:

```
Range: bytes={offset}-{offset + length - 1}
```

## 6. Metadata Section

Optional JSON at `metadata_offset`. Contains auxiliary information:

```json
{
    "description": "WorldPop 2025 global population density, 1km",
    "source": "https://www.worldpop.org/",
    "nodata": -99999,
    "units": "persons per km²",
    "year": 2025
}
```

If `metadata_offset = 0`, no metadata is present.

## 7. Coordinate System

### Standard CRS (crs > 0)

When `crs` is a valid EPSG code (e.g., 4326), `origin_x/y` and `extent_x/y` are in that CRS's native units.

For EPSG:4326:
- `origin_x` = westernmost longitude
- `origin_y` = northernmost latitude
- `extent_x` = total longitude span
- `extent_y` = total latitude span

Cell center coordinates:

```
cell_size_x = extent_x / 2^zoom
cell_size_y = extent_y / 2^zoom
x = origin_x + col * cell_size_x + cell_size_x / 2
y = origin_y - row * cell_size_y - cell_size_y / 2
```

### Custom CRS (crs = 0)

Origin and extent define an arbitrary planar coordinate system. The application must handle projection externally (e.g., via proj4 with parameters stored in metadata JSON).

## 8. Spatial Query Algorithm

### Per-cell access (fixed mode)

```
1. Download bitmask (can be served separately as .qbt.idx)
2. BFS-expand bitmask to find target cell's leaf_index
3. byte_offset = values_offset + leaf_index × entry_size
4. HTTP Range Request for entry_size bytes
```

### Bounding-box query (fixed mode)

```
1. Download bitmask
2. Convert bbox to row/col range at leaf zoom
3. BFS-traverse bitmask, descend only into quadrants overlapping bbox
4. Collect leaf indices of matching cells
5. Merge adjacent indices into contiguous byte ranges
6. Fetch merged ranges via Range Requests
```

Z-order (quadkey) sorting guarantees that spatially nearby cells have nearby leaf indices, producing few merged ranges for compact spatial queries.

### Tile access (variable mode)

```
1. Download and decompress index file (.qbt.idx.gz)
2. Deserialize bitmask + varint arrays
3. Look up tile by quadkey → offset + length
4. Range Request to data file
```

## 9. File Extensions

| Extension        | Description                                      |
|------------------|--------------------------------------------------|
| `.qbt`           | QBTiles file (header + bitmask + values/varints)  |
| `.qbt.gz`        | Gzip-compressed QBTiles (variable mode typical)  |
| `.qbt.idx`       | Bitmask-only index (header + bitmask, no values) |
| `.qbt.idx.gz`    | Gzip-compressed bitmask-only index               |
| `.qbt.values`    | Values-only file (fixed mode, Range-requestable) |

### Split-file deployment (fixed mode)

For per-cell Range Request access, the file can be split:

- **Index**: `.qbt.idx.gz` — header + bitmask, gzip-compressed (~MB), downloaded once
- **Values**: `.qbt.values` — raw values, uncompressed (~hundreds of MB), Range-requested

The index header's `values_offset` is 0 in split mode; the client uses `leaf_index × entry_size` directly against the values file URL.

## 10. Columnar vs Row Storage

Variable mode uses **columnar** layout (all run_lengths, then all lengths, then all offsets) rather than row-oriented (per-node triplets). This produces smaller gzip output because:

- Same-type values clustered → smaller deltas → fewer varint bytes
- gzip finds more repeated byte patterns in homogeneous data

## 11. Summary

```
                    Variable mode           Fixed row               Fixed columnar
                    (flags=0x0)             (flags=0x1)             (flags=0x3)
─────────────────   ──────────────────────  ──────────────────────  ──────────────────────
Use case            Tile archives           Raster grids (Range)    Compressed grids
ID storage          Zero (bitmask)          Zero (bitmask)          Zero (bitmask)
Per-entry metadata  offset+length (varint)  None (index-computed)   None
Value types         N/A                     Fixed-size only (1–9)   Fixed + varint (1–10)
Access              Per tile                Per cell (Range Req)    Whole file (gzip)
Compression         Index: gzip; Data: any  Index: gzip; Values: ×  Entire file: gzip
Replaces            PMTiles                 COG (sparse)            Parquet (sparse)
```
