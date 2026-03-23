# Example: Custom Coordinate System

Using QBTiles with arbitrary projected coordinates (not XYZ web tiles).

The `fit_grid()` function automatically calculates grid parameters from a bounding box, ensuring integer coordinates at all zoom levels.

Full source: [examples/02_custom_crs.py](https://github.com/vuski/qbtiles/blob/main/examples/02_custom_crs.py)

## Key Steps

### 1. Calculate grid parameters from bbox

```python
def fit_grid(min_x, min_y, max_x, max_y, zoom):
    """Auto-calculate origin and extent that guarantee integer coordinates."""
    n = 2 ** zoom
    data_range = max(max_x - min_x, max_y - min_y)
    tile_size = max(1, math.ceil(data_range / n))

    while True:
        extent = tile_size * n
        origin_x = math.floor(min_x / tile_size) * tile_size
        origin_y = math.floor(min_y / tile_size) * tile_size
        if origin_x + extent >= max_x and origin_y + extent >= max_y:
            break
        tile_size += 1

    return origin_x, origin_y, extent, tile_size

# User only needs bbox + zoom
origin_x, origin_y, extent, tile_size = fit_grid(
    min_x=120000, min_y=220000,
    max_x=180000, max_y=280000,
    zoom=10
)
```

### 2. Encode coordinates to quadkey

```python
def encode_quadkey(x, y, zoom, origin_x, origin_y, extent):
    rel_x = x - origin_x
    rel_y = y - origin_y
    tile_size = extent / (2 ** zoom)
    tile_x = int(rel_x // tile_size)
    tile_y = int(rel_y // tile_size)
    return qbt.tile_to_quadkey_int64(zoom, tile_x, tile_y)
```

### 3. Build and query — same as XYZ tiles

```python
qk = encode_quadkey(150000, 250000, ZOOM, origin_x, origin_y, extent)
entry = index_dict[qk]
# → offset, length for Range Request
```
