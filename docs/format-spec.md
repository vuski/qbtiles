# Binary Format Specification

## Overview

A QBTiles index file is a **gzip-compressed binary**. After decompression:

```
[4-byte header] [bitmask section] [varint section]
```

## 1. Header (4 bytes)

Big-endian uint32 representing the **byte length** of the bitmask section.

```
offset 0–3: bitmask_byte_length (uint32, big-endian)
```

## 2. Bitmask Section

The quadtree is traversed in **BFS (breadth-first) order**, recording each node's child presence as a 4-bit bitmask.

### Bitmask Encoding

```
Bit position:  [3] [2] [1] [0]
Child number:   0   1   2   3
Bit value:      8   4   2   1
```

- Children 0, 2, 3 exist: `1011` = 8+2+1 = 11
- All 4 children exist: `1111` = 15

### Byte Packing

Two 4-bit bitmasks are packed per byte:

```
byte = (first_bitmask << 4) | second_bitmask
```

If the total bitmask count is odd, the last byte's low nibble is padded with 0. During deserialization, a trailing 0 nibble is removed.

### BFS Traversal Order

```
Level 0 (root):     [root bitmask]
Level 1:            [child0 bitmask] [child1 bitmask] ...
Level 2:            [grandchildren bitmasks...]
...
```

Traversal stops when reaching a level where all bitmasks are 0.

![quadkey bitmask structure](quadkey_bitmask.png)

In the diagram above, quadkey "1" has bitmask `0100` (only child 1 exists), then "13" has bitmask `0001` (only child 3 exists), and so on. Following bitmasks alone reconstructs all quadkeys. At levels 9–10, dense tile regions show many 1-bits, making bitmask encoding more efficient than storing individual tile IDs.

### Key: No Tile IDs Stored

By reading bitmasks in BFS order and expanding children, each node's quadkey is **reconstructed from the tree structure**. No tile IDs or quadkeys need to be stored individually.

## 3. Varint Section (Columnar Storage)

From after the bitmask section to end of file. Three varint arrays stored **column-wise**:

```
[run_lengths array] [lengths array] [offsets array]
```

Each array has element count = bitmask count (= number of BFS-traversed nodes).

### run_lengths[]

Each tile's run_length value. Varint encoded.

### lengths[]

Each tile's data byte length. Varint encoded.
Nodes with `length == 0` are internal nodes (no data).

### offsets[] (Delta Encoding)

Each tile's byte offset within the data file. Same delta encoding as PMTiles:

- Contiguous tiles (`offset[i] == offset[i-1] + length[i-1]`): write `0`
- Non-contiguous tiles: write `offset[i] + 1`

## 4. Why Columnar Storage

Grouping values of the same type sequentially:
- Delta values have smaller variance → fewer varint bytes
- gzip compression finds more repeated patterns → better compression ratio

Columnar layout produces smaller final .gz files than row-oriented (per-node run_length+length+offset) layout.

## 5. Deserialization Algorithm

```
1. Decompress gzip
2. Read bitmask_byte_length from header
3. Read bitmask bytes, split into 4-bit nibbles
4. BFS expansion to reconstruct all quadkeys:
   - Root quadkey = "" (or integer 3)
   - For each bitmask, bits that are 1 → generate child quadkey
   - Add generated children to next level's queue
5. Read run_lengths[], lengths[], offsets[] from varint section
6. Keep only entries where length > 0
```

## 6. Data File Access

Use offset and length from the index for HTTP Range Requests:

```
Range: bytes={offset}-{offset + length - 1}
```

Works with serverless storage (S3, CloudFlare R2, etc.) — no tile server needed.
