# Example: XYZ Tiles

Standard XYZ web tile indexing — build, serialize, deserialize, and verify.

Full source: [examples/01_xyz_tiles.py](https://github.com/vuski/qbtiles/blob/main/examples/01_xyz_tiles.py)

## Key Steps

### 1. Prepare tile entries

```python
import qbtiles as qbt

tiles = [
    (3, 6, 3, 0,     1024),
    (3, 6, 4, 1024,  2048),
    (3, 7, 3, 3072,  1536),
    # ...
]
```

### 2. Convert to quadkey and build tree

```python
quadkey_info = []
for z, x, y, offset, length in tiles:
    qk = qbt.tile_to_quadkey_int64(z, x, y)
    quadkey_info.append((qk, "", offset, length, 1))

quadkey_info.sort(key=lambda x: x[0])
root = qbt.build_quadtree(quadkey_info)
```

### 3. Serialize index

```python
qbt.write_tree_bitmask_to_single_file(root, "index.gz", verbose=True)
```

### 4. Deserialize and verify

```python
entries = qbt.deserialize_quadtree_index("index.gz")
index_dict = qbt.build_quadkey_index_dict(entries)

# Lookup a tile
qk = qbt.tile_to_quadkey_int64(4, 13, 7)
entry = index_dict[qk]
print(f"offset={entry['offset']}, length={entry['length']}")
print(f"Range: bytes={entry['offset']}-{entry['offset'] + entry['length'] - 1}")
```
