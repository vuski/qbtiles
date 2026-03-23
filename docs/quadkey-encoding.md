# Quadkey Int64 Encoding

## Standard Quadkeys

Map tiles subdivide into 4 at each zoom level. Assigning digits 0–3 to each subdivision gives a string representation of tile position.

```
Level 1:  4 tiles   (0, 1, 2, 3)
Level 2:  16 tiles  (00, 01, 02, 03, 10, 11, ..., 33)
Level 3:  64 tiles  (000, 001, ..., 333)
...
Level z:  4^z tiles
```

Each digit represents a position in a 2×2 split: 0=top-left, 1=top-right, 2=bottom-left, 3=bottom-right.

Each digit's bit encoding:
```
digit = ((y >> i) & 1) << 1 | ((x >> i) & 1)

  digit 0: x=0, y=0 (top-left)
  digit 1: x=1, y=0 (top-right)
  digit 2: x=0, y=1 (bottom-left)
  digit 3: x=1, y=1 (bottom-right)
```

## String Limitation

Converting quadkey strings to integers for fast sorting/comparison introduces ambiguity:

```
"0"   → 0
"00"  → 0   ← indistinguishable!
"000" → 0   ← indistinguishable!
"032" → 32
"0032"→ 32  ← indistinguishable!
```

Different zoom levels produce the same integer.

## The 0b11 Prefix Trick

Solution: prepend **`3` (binary `11`)** as a prefix sentinel.

```
"0"   → "30"    → binary: 11 00             → int 12
"00"  → "300"   → binary: 11 00 00          → int 48
"000" → "3000"  → binary: 11 00 00 00       → int 192
"032" → "3032"  → binary: 11 00 11 10       → int 206
```

All produce distinct integers.

### Why `3`?

Each quadkey digit is 0, 1, 2, or 3. `3` is a valid digit, but at the **first position it serves only as a prefix sentinel**. In binary it's `11`, so when scanning 2-bit pairs, encountering `11` means "actual quadkey starts here."

## Conversion Functions

### z/x/y → int64

```python
def tile_to_quadkey_int64(z, x, y):
    quadkey_int64 = 3  # prefix 0b11
    for i in reversed(range(z)):
        digit = ((y >> i) & 1) << 1 | ((x >> i) & 1)
        quadkey_int64 = (quadkey_int64 << 2) | digit
    return quadkey_int64
```

### int64 → z/x/y

```python
def quadkey_int64_to_zxy(qint64):
    x = y = 0
    found_prefix = False
    z = 0
    for shift in reversed(range(0, 64, 2)):
        digit = (qint64 >> shift) & 0b11
        if not found_prefix:
            if digit == 0b11:
                found_prefix = True
            continue
        x = (x << 1) | (digit & 1)
        y = (y << 1) | ((digit >> 1) & 1)
        z += 1
    return z, x, y
```

## Properties

- **Sortable**: Sorting int64 quadkeys preserves spatial locality
- **Compact**: Fixed 64-bit integer instead of variable-length string
- **Zoom range**: 64 bits − 2 bits (prefix) = 62 bits / 2 bits per level = **max zoom 31**
- **Fast traversal**: Parent-child relationships via integer operations
    - Parent quadkey = child quadkey >> 2
    - Child quadkey = (parent quadkey << 2) | digit
