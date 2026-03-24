"""Utilities for the population grid example.

- Compact serialization for small integer values on a quadtree bitmask
- KOSTAT grid ID to EPSG:5179 coordinate conversion
"""

import gzip
from io import BytesIO
import sys, os

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src", "python"))
import qbtiles as qbt


# ============================================================
# KOSTAT Grid ID Conversion
# ============================================================

_TRANS_X = pd.DataFrame({
    "hx": ["가", "나", "다", "라", "마", "바", "사"],
    "xx": [700000, 800000, 900000, 1000000, 1100000, 1200000, 1300000]
})

_TRANS_Y = pd.DataFrame({
    "hy": ["가", "나", "다", "라", "마", "바", "사", "아"],
    "yy": [1300000, 1400000, 1500000, 1600000, 1700000, 1800000, 1900000, 2000000]
})


def convert_grid_id_to_xy(df, id_col, gridsize):
    """Convert KOSTAT grid IDs to EPSG:5179 projected coordinates.

    Args:
        df: DataFrame containing grid ID column.
        id_col: Name of the grid ID column (e.g. "가다780670").
        gridsize: One of "100m", "500m", "1km", "10km", "100km", "250m", "250mEx".

    Returns:
        DataFrame with columns [id_col, "{id_col}_x", "{id_col}_y"].
    """
    df_sub = df[[id_col]].copy()
    df_sub["gridstr"] = df_sub[id_col].replace("99", np.nan)
    df_sub["hx"] = df_sub["gridstr"].str[0:1]
    df_sub["hy"] = df_sub["gridstr"].str[1:2]
    df_sub = df_sub.merge(_TRANS_X, how='left', on='hx')
    df_sub = df_sub.merge(_TRANS_Y, how='left', on='hy')

    if gridsize == "100m":
        df_sub["nums"] = df_sub["gridstr"].str[2:].astype(float)
        df_sub["x"] = df_sub["xx"] + (df_sub["nums"] // 1000).astype(int) * 100 + 50
        df_sub["y"] = df_sub["yy"] + (df_sub["nums"] % 1000).astype(int) * 100 + 50
    elif gridsize == "1km":
        df_sub["nums"] = df_sub["gridstr"].str[2:].astype(float)
        df_sub["x"] = df_sub["xx"] + (df_sub["nums"] // 100).astype(int) * 1000 + 500
        df_sub["y"] = df_sub["yy"] + (df_sub["nums"] % 100).astype(int) * 1000 + 500
    elif gridsize == "10km":
        df_sub["nums"] = df_sub["gridstr"].str[2:].astype(float)
        df_sub["x"] = df_sub["xx"] + (df_sub["nums"] // 10).astype(int) * 10000 + 5000
        df_sub["y"] = df_sub["yy"] + (df_sub["nums"] % 10).astype(int) * 10000 + 5000
    elif gridsize == "100km":
        df_sub["x"] = df_sub["xx"]
        df_sub["y"] = df_sub["yy"]
    elif gridsize == "500m":
        df_sub["xa"] = np.where(df_sub["gridstr"].str[4] == 'a', 0, 500)
        df_sub["ya"] = np.where(df_sub["gridstr"].str[7] == 'a', 0, 500)
        df_sub["x"] = df_sub["xx"] + df_sub["gridstr"].str[2:4].astype(int) * 1000 + df_sub["xa"] + 250
        df_sub["y"] = df_sub["yy"] + df_sub["gridstr"].str[5:7].astype(int) * 1000 + df_sub["ya"] + 250
    elif gridsize == "250m":
        xa1 = np.where(df_sub["gridstr"].str[4] == 'a', 0, 500)
        xa2 = np.where(df_sub["gridstr"].str[5] == 'a', 0, 250)
        ya1 = np.where(df_sub["gridstr"].str[8] == 'a', 0, 500)
        ya2 = np.where(df_sub["gridstr"].str[9] == 'a', 0, 250)
        df_sub["xa"] = xa1 + xa2
        df_sub["ya"] = ya1 + ya2
        df_sub["x"] = df_sub["xx"] + df_sub["gridstr"].str[2:4].astype(int) * 1000 + df_sub["xa"] + 125
        df_sub["y"] = df_sub["yy"] + df_sub["gridstr"].str[6:8].astype(int) * 1000 + df_sub["ya"] + 125
    elif gridsize == "250mEx":
        df_sub["x"] = df_sub["xx"] + df_sub["gridstr"].str[2:6].astype(int) * 10 + 125
        df_sub["y"] = df_sub["yy"] + df_sub["gridstr"].str[6:10].astype(int) * 10 + 125
    else:
        raise ValueError(f"Unsupported gridsize: {gridsize}")

    df_result = df_sub[[id_col, "x", "y"]].copy()
    df_result.columns = [id_col, f"{id_col}_x", f"{id_col}_y"]
    return df_result


# ============================================================
# Bitmask Value Serialization
# ============================================================


def write_bitmask_values(root, output_path, leaf_zoom, verbose=False):
    """Serialize a quadtree with 3 integer values per leaf node.

    Values are stored in offset/length/run_length fields of each leaf node.
    The bitmask encodes tree structure; values are packed after the bitmask section.

    Args:
        root: QuadTreeNode root.
        output_path: Output .gz file path.
        leaf_zoom: Zoom level where leaf data exists.
        verbose: Print stats if True.
    """
    current_level = [root]
    bitmask_list = []
    values_a, values_b, values_c = [], [], []
    level = 0

    while current_level:
        next_level = []
        for node in current_level:
            bitmask = 0
            for key in range(4):
                if key in node.children:
                    bitmask |= (8 >> key)
                    next_level.append(node.children[key])
            bitmask_list.append(bitmask)

            if level == leaf_zoom:
                values_a.append(node.offset)
                values_b.append(node.length)
                values_c.append(node.run_length)

        if sum(bitmask_list[-len(current_level):]) == 0:
            bitmask_list = bitmask_list[:-len(current_level)]
            break

        current_level = next_level
        level += 1

    # Pack bitmasks (two 4-bit values per byte)
    bitmask_bytes = bytearray()
    for i in range(0, len(bitmask_list), 2):
        first = bitmask_list[i]
        second = bitmask_list[i + 1] if i + 1 < len(bitmask_list) else 0
        bitmask_bytes.append((first << 4) | second)

    # Pack values with adaptive bit-width
    value_io = BytesIO()
    for a, b, c in zip(values_a, values_b, values_c):
        if a == 0 and b == 0 and c == 0:
            value_io.write(bytes([0b00000000]))
        elif a < 16 and b < 16 and c < 16:
            value_io.write(bytes([0b00010000 | a, (b << 4) | c]))
        elif a < 256 and b < 256 and c < 256:
            value_io.write(bytes([0b00100000, a, b, c]))
        else:
            value_io.write(bytes([0b00110000]))
            value_io.write(a.to_bytes(2, "little"))
            value_io.write(b.to_bytes(2, "little"))
            value_io.write(c.to_bytes(2, "little"))

    # Combine and compress
    total_io = BytesIO()
    total_io.write(len(bitmask_bytes).to_bytes(4, "big"))
    total_io.write(bitmask_bytes)
    total_io.write(value_io.getvalue())

    compressed = gzip.compress(total_io.getvalue())
    with open(output_path, "wb") as f:
        f.write(compressed)

    if verbose:
        print(f"Saved: {output_path}")
        print(f"  Bitmask: {len(bitmask_bytes):,} bytes ({len(bitmask_list):,} nodes)")
        print(f"  Leaf values: {len(values_a):,}")
        print(f"  File size: {len(compressed):,} bytes ({len(compressed)/1024/1024:.1f} MB)")


def read_bitmask_values(filepath, leaf_zoom):
    """Deserialize a bitmask file with 3 integer values per leaf.

    Args:
        filepath: Path to the .gz file.
        leaf_zoom: Zoom level where leaf data exists.

    Returns:
        List of dicts with keys: quadkey_int, a, b, c.
    """
    with gzip.open(filepath, "rb") as f:
        b = f.read()

    b_io = BytesIO(b)
    bitmask_len = int.from_bytes(b_io.read(4), "big")
    bitmask_bytes = b_io.read(bitmask_len)
    v_io = BytesIO(b_io.read())

    # Unpack bitmasks
    bitmasks = []
    for byte in bitmask_bytes:
        bitmasks.append(byte >> 4)
        bitmasks.append(byte & 0x0F)
    if bitmasks and bitmasks[-1] == 0:
        bitmasks.pop()

    # BFS to recover quadkeys at leaf_zoom
    quadkeys = []
    queue = [""]
    i = 0
    while i < len(bitmasks):
        next_queue = []
        for parent in queue:
            if i >= len(bitmasks):
                break
            children = qbt.expand_quadkey(parent, bitmasks[i])
            if len(children) > 0 and len(children[0]) == leaf_zoom:
                quadkeys.extend(children)
            next_queue.extend(children)
            i += 1
        queue = next_queue

    # Read values
    entries = []
    for qk_str in quadkeys:
        head = v_io.read(1)
        if not head:
            raise ValueError("Unexpected EOF")

        prefix = head[0] >> 4
        if prefix == 0b0000:
            a, b, c = 0, 0, 0
        elif prefix == 0b0001:
            second = v_io.read(1)
            a = head[0] & 0x0F
            b = (second[0] >> 4) & 0x0F
            c = second[0] & 0x0F
        elif prefix == 0b0010:
            rest = v_io.read(3)
            a, b, c = rest[0], rest[1], rest[2]
        elif prefix == 0b0011:
            rest = v_io.read(6)
            a = int.from_bytes(rest[0:2], "little")
            b = int.from_bytes(rest[2:4], "little")
            c = int.from_bytes(rest[4:6], "little")
        else:
            raise ValueError(f"Unknown prefix: {prefix:04b}")

        if a > 0 or b > 0 or c > 0:
            entries.append({
                "quadkey_int": qbt.quadkey_str_to_int64(qk_str),
                "a": a, "b": b, "c": c
            })

    return entries
