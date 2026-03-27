# Comparison with PMTiles and SVO

## PMTiles vs QBTiles

### PMTiles Index Structure

```
[entry_count (varint)]
[tile_id_delta_0, tile_id_delta_1, ... (varint array)]
[run_length_0, run_length_1, ... (varint array)]
[length_0, length_1, ... (varint array)]
[offset_0, offset_1, ... (varint array, delta encoded)]
```

- Each tile requires a **tile_id delta stored as varint**
- Sparse tile distributions → larger deltas → more bytes
- Empty tiles are "skipped" by encoding the gap as a number

### QBTiles File Structure

```
[128B+ header: magic, version, flags, zoom, CRS, origin, extent,
               bitmask_length, values_offset, index_hash, field schema]
[bitmask section: 4-bit × 2 packed, BFS order (gzip-compressed)]
[values section: varints (variable mode) or fixed-size entries (fixed mode)]
```

- **No tile_id array** — quadkeys reconstructed from bitmasks
- Non-existent tiles are bit 0 — **zero cost**
- Columnar storage → same-type values together → better compression
- Three modes: variable-entry (tiles), fixed row (Range Request), fixed columnar (bulk)

### Core Difference

PMTiles **enumerates** tile IDs with deltas.
QBTiles **structurally encodes** tile existence via bitmasks.

In the structural approach, non-existent tiles incur no additional cost. This is more efficient in the common case where tiles cover only a portion of the total space.

---

## Sparse Voxel Octree (SVO) vs QBTiles

SVO is the **most directly analogous technique** — the same idea in 3D.

### Similarities

| | SVO | QBTiles |
|---|---|---|
| Spatial subdivision | Octree (8-way) | Quadtree (4-way) |
| Existence encoding | 8-bit bitmask | 4-bit bitmask |
| Core principle | Serialize only existing children → decode by sequential read | Same |
| Empty region cost | 0 bits | 0 bits |
| Partial access | Shader traversal in VRAM | HTTP Range Request |

Both use **"bitmask for existence → serialize only what exists → decode by sequential read"**.

### Difference 1: Data Layout — Row vs Column

**SVO uses row-oriented (mask+data adjacent)**:
```
[mask][data] [mask][data] [mask][data] ...
```

**QBTiles uses column-oriented (same-type values together)**:
```
[mask][mask][mask]... [offset][offset][offset]... [length][length][length]...
```

This difference comes from **access patterns**:

| | SVO | QBTiles |
|---|---|---|
| Access pattern | **Partial traversal** (ray casting) | **Full decode** then Map lookup |
| Environment | GPU shader, VRAM | Browser, network |
| Bottleneck | GPU cache misses | Network transfer size |
| Optimization goal | Minimize **memory accesses** per traversal | Minimize **file size** |

SVO shaders cast millions of rays per frame, each traversing different tree paths. Full decoding is impractical. So masks are placed adjacent to data for cache-friendly traversal.

QBTiles indices are small (KB to tens of MB). Full download and batch decoding is practical. So column-oriented layout maximizes delta + gzip compression.

### Difference 2: Index-Data Relationship

| | SVO | QBTiles |
|---|---|---|
| Relationship | **Index = Data** | **Index ≠ Data** |
| Description | Tree itself is VRAM-resident data | Index provides offset/length; data fetched via Range Request |

SVO embeds voxel data (color, density) within the tree structure. Traversing the tree *is* accessing the data.

QBTiles **separates** the index (tree structure + metadata) from the data (actual tile binaries) within a single `.qbt` file. The index section tells where each tile is; actual data is fetched from the values section of the same file via Range Request. The index hash (SHA-256) enables index reuse across multiple files sharing the same spatial structure.

### Summary

SVO and QBTiles apply the same core idea (bitmask-based tree serialization) **optimized for different domains**:

- SVO → 3D rendering, VRAM traversal, row-oriented
- QBTiles → Geographic tiles, network transfer, column-oriented
