"""
QBTiles - Quadtree Bitmask Tile Index

클라우드 최적화 타일 아카이브 인덱스 포맷.
쿼드트리 비트마스크 인덱싱으로 타일 ID를 개별 저장하지 않고
BFS 순회로 모든 quadkey를 복원한다.
"""

import os
import io
import gzip
import struct
import hashlib
from io import BytesIO


# ============================================================
# QuadTree Node
# ============================================================

class QuadTreeNode:
    def __init__(self):
        self.children = {}       # 0, 1, 2, 3
        self.has_value = False   # 이 노드에 타일 데이터가 존재하는지 여부
        self.offset = 0
        self.length = 0
        self.run_length = 1


# ============================================================
# Quadkey 변환 함수들
# ============================================================

def tile_to_quadkey(z, x, y):
    """z/x/y 타일 좌표를 쿼드키 문자열로 변환"""
    quadkey = ""
    for i in range(z, 0, -1):
        digit = 0
        mask = 1 << (i - 1)
        if x & mask:
            digit += 1
        if y & mask:
            digit += 2
        quadkey += str(digit)
    return quadkey


def quadkey_to_tile(quadkey):
    """쿼드키 문자열을 z/x/y 타일 좌표로 변환"""
    x = y = 0
    z = len(quadkey)
    for i, digit in enumerate(quadkey):
        mask = 1 << (z - i - 1)
        d = int(digit)
        if d & 1:
            x |= mask
        if d & 2:
            y |= mask
    return z, x, y


def tile_to_quadkey_int64(z, x, y):
    """z/x/y를 64비트 정수 쿼드키로 변환.
    앞에 0b11(=3) 프리픽스를 붙여 "0"과 "00" 등의 모호성을 해결한다."""
    quadkey_int64 = 3
    for i in reversed(range(z)):
        digit = ((y >> i) & 1) << 1 | ((x >> i) & 1)
        quadkey_int64 = (quadkey_int64 << 2) | digit
    return quadkey_int64


def quadkey_int64_to_zxy(qint64):
    """64비트 정수 쿼드키를 z/x/y로 변환.
    0b11 프리픽스를 찾아서 이후 2비트씩 디코딩한다."""
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


def quadkey_int64_to_str(qint64: int) -> str:
    """64비트 정수 쿼드키를 문자열로 변환"""
    result = ""
    found_prefix = False

    for shift in reversed(range(0, 64, 2)):
        digit = (qint64 >> shift) & 0b11

        if not found_prefix:
            if digit == 0b11:
                found_prefix = True
            continue

        result += str(digit)

    return result


def quadkey_to_zxy(quadkeyStr: str) -> tuple:
    """쿼드키 문자열을 z/x/y로 변환"""
    z = len(quadkeyStr)
    x = y = 0
    for i, c in enumerate(quadkeyStr):
        mask = 1 << (z - i - 1)
        digit = int(c)
        if digit & 1:
            x |= mask
        if digit & 2:
            y |= mask
    return z, x, y


def quadkey_str_to_int64(qk):
    """문자열 쿼드키를 64비트 정수로 변환 (2비트 shift 방식)"""
    qk = "3" + qk  # 안정적인 정렬을 위해 '3' 접두어 추가
    result = 0
    for d in qk:
        result = (result << 2) | int(d)
    return result


# ============================================================
# 힐베르트 타일 ID 변환 (PMTiles 호환)
# ============================================================

def rotate(n, x, y, rx, ry):
    if ry == 0:
        if rx != 0:
            x = n - 1 - x
            y = n - 1 - y
        x, y = y, x
    return x, y


def tileid_to_zxy(tile_id):
    """힐베르트 곡선 기반 타일 ID를 z/x/y로 변환"""
    z = ((3 * tile_id + 1).bit_length() - 1) // 2
    if z >= 32:
        raise OverflowError("tile zoom exceeds 64-bit limit")
    acc = ((1 << (z * 2)) - 1) // 3
    pos = tile_id - acc
    x = 0
    y = 0
    s = 1
    n = 1 << z
    while s < n:
        rx = (pos // 2) & s
        ry = (pos ^ rx) & s
        (x, y) = rotate(s, x, y, rx, ry)
        x += rx
        y += ry
        pos >>= 1
        s <<= 1
    return (z, x, y)


def tileid_to_quadkey_int64(tile_id):
    """힐베르트 타일 ID를 64비트 정수 쿼드키로 변환"""
    z, x, y = tileid_to_zxy(tile_id)
    return tile_to_quadkey_int64(z, x, y)


def tileid_to_quadkey_str(tile_id):
    """힐베르트 타일 ID를 쿼드키 문자열로 변환"""
    z, x, y = tileid_to_zxy(tile_id)
    return tile_to_quadkey(z, x, y)


# ============================================================
# Varint 읽기/쓰기
# ============================================================

def write_varint(b_io, i):
    while True:
        towrite = i & 0x7F
        i >>= 7
        if i:
            b_io.write(bytes([towrite | 0x80]))
        else:
            b_io.write(bytes([towrite]))
            break


def read_varint(b_io):
    shift = 0
    result = 0
    while True:
        raw = b_io.read(1)
        if raw == b"":
            raise EOFError("unexpectedly reached end of varint stream")
        i = raw[0]
        result |= (i & 0x7F) << shift
        shift += 7
        if not (i & 0x80):
            break
    return result


# ============================================================
# 쿼드트리 구축
# ============================================================

def insert_quadkey(quadkey_int64: int, offset, length, root, run_length):
    """64비트 정수 쿼드키를 쿼드트리에 삽입"""
    node = root
    started = False

    for shift in reversed(range(0, 64, 2)):
        digit = (quadkey_int64 >> shift) & 0b11

        if not started:
            if digit == 0b11:
                started = True
            continue

        if digit not in (0, 1, 2, 3):
            raise ValueError(f"Invalid digit: {digit}")

        if digit not in node.children:
            node.children[digit] = QuadTreeNode()

        node = node.children[digit]

    if node.has_value:
        print(f"[중복 삽입 경고] 이미 존재하는 타일: {quadkey_int64}")
    node.has_value = True
    node.offset = offset
    node.length = length
    node.run_length = run_length


def build_quadtree(quadkey_info):
    """quadkey_info 리스트로부터 쿼드트리를 구축한다.
    quadkey_info: [(quadkey_int64, path, offset, length, run_length), ...]
    """
    root = QuadTreeNode()
    for quadkey, full_path, offset, length, run_length in quadkey_info:
        insert_quadkey(quadkey, offset, length, root, run_length)
    return root


# ============================================================
# 인덱스 직렬화 (쿼드트리 → 바이너리)
# ============================================================

def write_tree_bitmask_to_single_file(root, output_path, verbose=False):
    """쿼드트리를 BFS 순회하여 바이너리 인덱스 파일로 직렬화한다.

    파일 구조 (gzip 압축):
    [4바이트 헤더: 비트마스크 바이트 길이]
    [비트마스크 섹션: 4비트씩 2개를 1바이트에 팩킹]
    [varint 섹션: run_lengths[] → lengths[] → offsets[] (열 방향, delta 인코딩)]
    """
    current_level = [root]
    bitValueArr = [8, 4, 2, 1]
    bitmask_list = []
    run_lengths = []
    lengths = []
    offsets = []

    while current_level:
        next_level = []
        bitmask_groups = []

        for node in current_level:
            bitValue = 0
            for key in range(4):
                if key in node.children:
                    bitValue += bitValueArr[key]
                    next_level.append(node.children[key])
            bitmask_groups.append(bitValue)
            run_lengths.append(node.run_length)
            lengths.append(node.length)
            offsets.append(node.offset)

        if sum(bitmask_groups) == 0:
            break

        bitmask_list.extend(bitmask_groups)
        current_level = next_level

    # 1. 비트마스크 직렬화 (4비트 2개씩 1바이트에 팩킹)
    bitmask_bytes = bytearray()
    for i in range(0, len(bitmask_list), 2):
        first = bitmask_list[i]
        second = bitmask_list[i + 1] if i + 1 < len(bitmask_list) else 0
        byte = (first << 4) | second
        bitmask_bytes.append(byte)

    # 2. 열 방향으로 varint 직렬화: run_lengths → lengths → offsets
    value_io = BytesIO()

    for val in run_lengths:
        write_varint(value_io, val)

    for val in lengths:
        write_varint(value_io, val)

    # offset은 delta 인코딩 (PMTiles 방식과 동일)
    for i in range(len(offsets)):
        if i > 0 and offsets[i] == offsets[i - 1] + lengths[i - 1]:
            write_varint(value_io, 0)
        else:
            write_varint(value_io, offsets[i] + 1)

    # 전체를 합쳐서 gzip 압축
    total_io = BytesIO()
    total_io.write(len(bitmask_bytes).to_bytes(4, byteorder="big"))
    total_io.write(bitmask_bytes)
    total_io.write(value_io.getvalue())

    compressed = gzip.compress(total_io.getvalue())
    with open(output_path, "wb") as f:
        f.write(compressed)

    if verbose:
        print(f"저장 완료: {output_path}")
        print(f" - 비트마스크 바이트: {len(bitmask_bytes)} bytes")
        print(f" - 비트마스크 개수: {len(bitmask_list)}")
        print(f" - 엔트리 개수: {len(run_lengths)}")


# ============================================================
# 인덱스 역직렬화 (바이너리 → 엔트리 리스트)
# ============================================================

def expand_quadkey(parent_key, bitmask):
    """부모 쿼드키와 비트마스크로 자식 쿼드키 생성"""
    children = []
    for i in range(4):
        if bitmask & (1 << (3 - i)):
            children.append(parent_key + str(i))
    return children


def deserialize_quadtree_index(filepath_or_bytes):
    """인덱스를 읽어 엔트리 리스트로 복원한다.

    Args:
        filepath_or_bytes: gzip 파일 경로(str) 또는 decompressed bytes.
    """
    if isinstance(filepath_or_bytes, (bytes, bytearray)):
        b = filepath_or_bytes
    else:
        with gzip.open(filepath_or_bytes, "rb") as f:
            b = f.read()

    b_io = BytesIO(b)
    bitmask_len = int.from_bytes(b_io.read(4), "big")
    bitmask_bytes = b_io.read(bitmask_len)
    varint_section = b_io.read()
    v_io = BytesIO(varint_section)

    # 1. 비트마스크 → 쿼드키 복원
    bitmasks = []
    for byte in bitmask_bytes:
        bitmasks.append(byte >> 4)
        bitmasks.append(byte & 0x0F)

    if bitmasks[-1] == 0:
        bitmasks.pop()

    quadkeys = [""]  # 루트 쿼드키
    queue = [""]
    i = 0
    while i < len(bitmasks):
        next_queue = []
        for parent in queue:
            if i >= len(bitmasks):
                break
            bm = bitmasks[i]
            children = expand_quadkey(parent, bm)
            quadkeys.extend(children)
            next_queue.extend(children)
            i += 1
        queue = next_queue

    # 2. 열 방향 varint 읽기: run_lengths → lengths → offsets
    run_lengths = [read_varint(v_io) for _ in quadkeys]
    lengths = [read_varint(v_io) for _ in quadkeys]

    offsets = []
    for i in range(len(quadkeys)):
        encoded = read_varint(v_io)
        if i > 0 and encoded == 0:
            offset = offsets[i - 1] + lengths[i - 1]
        else:
            offset = encoded - 1
        offsets.append(offset)

    # 3. 엔트리 구성
    entries = []
    vertex_offset = 0
    for i, qk in enumerate(quadkeys):
        if lengths[i] == 0:
            continue
        z, x, y = quadkey_to_zxy(qk)
        entries.append({
            "quadkey_int": quadkey_str_to_int64(qk),
            "quadkey": qk,
            "z": z,
            "x": x,
            "y": y,
            "offset": offsets[i],
            "length": lengths[i],
            "vertex_offset": vertex_offset,
            "vertex_length": run_lengths[i],
        })
        vertex_offset += run_lengths[i]

    return entries


def build_quadkey_index_dict(entries):
    """엔트리 리스트를 quadkey_int64 기반 딕셔너리로 변환"""
    return {entry["quadkey_int"]: entry for entry in entries}


# ============================================================
# PMTiles 호환 (크기 비교용)
# ============================================================

class Entry:
    """PMTiles 호환 엔트리 (인덱스 크기 비교용)"""
    __slots__ = ("tile_id", "offset", "length", "run_length")

    def __init__(self, tile_id, offset, length, run_length):
        self.tile_id = tile_id
        self.offset = offset
        self.length = length
        self.run_length = run_length

    def __str__(self):
        return f"id={self.tile_id} offset={self.offset} length={self.length} runlength={self.run_length}"


def serialize_directory(entries):
    """PMTiles 방식으로 디렉토리를 직렬화한다 (크기 비교용).
    tile_id delta + run_length + length + offset(delta)를 varint로 기록."""
    b_io = io.BytesIO()
    write_varint(b_io, len(entries))

    last_id = 0
    for e in entries:
        write_varint(b_io, e.tile_id - last_id)
        last_id = e.tile_id

    for e in entries:
        write_varint(b_io, e.run_length)

    for e in entries:
        write_varint(b_io, e.length)

    for i, e in enumerate(entries):
        if i > 0 and e.offset == entries[i - 1].offset + entries[i - 1].length:
            write_varint(b_io, 0)
        else:
            write_varint(b_io, e.offset + 1)

    return gzip.compress(b_io.getvalue())


# ============================================================
# High-level API
# ============================================================

class Entry:
    """PMTiles 호환 엔트리 (크기 비교용)"""
    __slots__ = ('tile_id', 'offset', 'length', 'run_length')
    def __init__(self, tile_id, offset, length, run_length):
        self.tile_id = tile_id
        self.offset = offset
        self.length = length
        self.run_length = run_length


def _tile2lat(y, n):
    """Convert tile Y index to latitude (Web Mercator)."""
    import math
    lat_rad = math.atan(math.sinh(math.pi * (1 - 2 * y / n)))
    return math.degrees(lat_rad)


def _extract_mvt_layer_names(folder, ext=".mvt"):
    """Extract MVT vector layer names by sampling tiles at different zoom levels.

    Scans the folder for tile files, samples one per zoom level,
    and parses MVT protobuf to extract layer names.
    """
    import gzip as _gzip
    layer_names = []
    sampled_zooms = set()

    for root_dir, dirs, files in os.walk(folder):
        for f in sorted(files):
            if not f.endswith(ext):
                continue
            # Parse z from path
            parts = os.path.relpath(os.path.join(root_dir, f), folder).replace("\\", "/").split("/")
            if len(parts) < 3:
                continue
            try:
                z = int(parts[0])
            except ValueError:
                continue
            if z in sampled_zooms:
                continue
            sampled_zooms.add(z)

            # Read and decompress tile
            filepath = os.path.join(root_dir, f)
            with open(filepath, "rb") as fh:
                data = fh.read()
            if data[:2] == b'\x1f\x8b':
                data = _gzip.decompress(data)

            # Parse MVT protobuf: top-level field 3 = Layer, Layer field 1 = name
            pos = 0
            while pos < len(data):
                # Read varint tag
                tag = 0
                shift = 0
                while pos < len(data):
                    b = data[pos]; pos += 1
                    tag |= (b & 0x7f) << shift; shift += 7
                    if not (b & 0x80):
                        break
                field_num = tag >> 3
                wire_type = tag & 0x7

                if wire_type == 2:  # length-delimited
                    length = 0; shift = 0
                    while pos < len(data):
                        b = data[pos]; pos += 1
                        length |= (b & 0x7f) << shift; shift += 7
                        if not (b & 0x80):
                            break
                    if field_num == 3 and length > 0:
                        # Layer message — parse field 1 (name)
                        layer_end = pos + length
                        inner_pos = pos
                        while inner_pos < layer_end:
                            it = 0; shift = 0
                            while inner_pos < layer_end:
                                b = data[inner_pos]; inner_pos += 1
                                it |= (b & 0x7f) << shift; shift += 7
                                if not (b & 0x80):
                                    break
                            if (it >> 3) == 1 and (it & 0x7) == 2:
                                nl = 0; shift = 0
                                while inner_pos < layer_end:
                                    b = data[inner_pos]; inner_pos += 1
                                    nl |= (b & 0x7f) << shift; shift += 7
                                    if not (b & 0x80):
                                        break
                                name = data[inner_pos:inner_pos + nl].decode('utf-8', errors='ignore')
                                if name and name not in layer_names:
                                    layer_names.append(name)
                                break
                            elif (it & 0x7) == 0:
                                while inner_pos < layer_end and data[inner_pos] & 0x80:
                                    inner_pos += 1
                                if inner_pos < layer_end:
                                    inner_pos += 1
                            else:
                                break
                        pos = layer_end
                    else:
                        pos += length
                elif wire_type == 0:
                    while pos < len(data) and data[pos] & 0x80:
                        pos += 1
                    if pos < len(data):
                        pos += 1
                elif wire_type == 5:
                    pos += 4
                elif wire_type == 1:
                    pos += 8
                else:
                    break

            if len(sampled_zooms) >= 20:
                break

    return layer_names


def index_tile_folder(folder, ext=".png"):
    """Scan a z/x/y tile folder and build a QBTiles index.

    Args:
        folder: Path to tile folder with z/x/y.{ext} structure.
        ext: Tile file extension (default: ".png").

    Returns:
        List of (quadkey_int64, filepath, offset, length, run_length) tuples,
        sorted by quadkey with offsets calculated for concatenation.
    """
    tiles = []
    for root, dirs, files in os.walk(folder):
        for f in files:
            if not f.endswith(ext):
                continue
            rel = os.path.relpath(os.path.join(root, f), folder)
            parts = rel.replace("\\", "/").split("/")
            if len(parts) != 3:
                continue
            z, x = int(parts[0]), int(parts[1])
            y = int(parts[2].replace(ext, ""))
            filepath = os.path.join(root, f)
            qk = tile_to_quadkey_int64(z, x, y)
            length = os.path.getsize(filepath)
            tiles.append((qk, filepath, 0, length, 1))

    tiles.sort(key=lambda t: t[0])

    # Recalculate offsets for sequential concatenation
    offset = 0
    result = []
    for qk, filepath, _, length, run_length in tiles:
        result.append((qk, filepath, offset, length, run_length))
        offset += length

    return result


def build_archive(folder, index_path, data_path, ext=".png"):
    """Build a QBTiles archive from a z/x/y tile folder.

    Creates two files:
    - index_path: gzip-compressed bitmask index (.idx.gz)
    - data_path: concatenated tile data (.data)

    Args:
        folder: Path to tile folder with z/x/y.{ext} structure.
        index_path: Output path for the index file.
        data_path: Output path for the data file.
        ext: Tile file extension (default: ".png").

    Returns:
        List of index entries (quadkey_int64, filepath, offset, length, run_length).
    """
    entries = index_tile_folder(folder, ext)

    # Build and serialize index
    root = build_quadtree(entries)
    write_tree_bitmask_to_single_file(root, index_path)

    # Concatenate tile data in quadkey order
    with open(data_path, "wb") as out:
        for qk, filepath, offset, length, run_length in entries:
            with open(filepath, "rb") as f:
                out.write(f.read())

    return entries


def load_index(index_path):
    """Load a QBTiles index and return a lookup dict.

    Args:
        index_path: Path to the .idx.gz index file.

    Returns:
        dict mapping quadkey_int64 -> {quadkey_int, z, x, y, offset, length, ...}
    """
    entries = deserialize_quadtree_index(index_path)
    return {e['quadkey_int']: e for e in entries}


def get_tile(data_path, index, z, x, y):
    """Retrieve a single tile's data from the archive.

    Args:
        data_path: Path to the .data file.
        index: Lookup dict from load_index().
        z, x, y: Tile coordinates.

    Returns:
        bytes of the tile data, or None if not found.
    """
    qk = tile_to_quadkey_int64(z, x, y)
    entry = index.get(qk)
    if entry is None:
        return None
    with open(data_path, "rb") as f:
        f.seek(entry['offset'])
        return f.read(entry['length'])


# ============================================================
# Custom CRS Support
# ============================================================

def encode_custom_quadkey(x, y, zoom, origin_x, origin_y, extent):
    """Encode a coordinate in a custom CRS to a quadkey int64.

    Args:
        x, y: Coordinate in the custom CRS.
        zoom: Zoom level.
        origin_x, origin_y: Grid origin (lower-left).
        extent: Grid extent (square).

    Returns:
        Quadkey as int64 with 0b11 prefix.
    """
    rel_x = x - origin_x
    rel_y = y - origin_y

    if not (0 <= rel_x < extent and 0 <= rel_y < extent):
        raise ValueError(f"Point ({x}, {y}) is out of grid bounds")

    tile_size = extent / (2 ** zoom)
    tile_x = int(rel_x // tile_size)
    tile_y = int(rel_y // tile_size)

    quadkey_int64 = 3  # 0b11 prefix
    for i in reversed(range(zoom)):
        digit = ((tile_y >> i) & 1) << 1 | ((tile_x >> i) & 1)
        quadkey_int64 = (quadkey_int64 << 2) | digit
    return quadkey_int64


def decode_custom_quadkey(qk_int64, zoom, origin_x, origin_y, extent):
    """Decode a quadkey int64 back to the center coordinate in a custom CRS.

    Args:
        qk_int64: Quadkey as int64 with 0b11 prefix.
        zoom: Zoom level.
        origin_x, origin_y: Grid origin (lower-left).
        extent: Grid extent (square).

    Returns:
        (x_center, y_center) tuple.
    """
    tile_x = 0
    tile_y = 0
    for i in range(zoom):
        digit = (qk_int64 >> (2 * (zoom - i - 1))) & 3
        tile_x = (tile_x << 1) | (digit & 1)
        tile_y = (tile_y << 1) | ((digit >> 1) & 1)

    tile_size = extent / (2 ** zoom)
    x_center = origin_x + tile_x * tile_size + tile_size / 2
    y_center = origin_y + tile_y * tile_size + tile_size / 2

    return int(x_center), int(y_center)


# ============================================================
# QBT v1.0 File Format
# ============================================================

# Type codes
TYPE_UINT8 = 1
TYPE_INT16 = 2
TYPE_UINT16 = 3
TYPE_INT32 = 4
TYPE_UINT32 = 5
TYPE_FLOAT32 = 6
TYPE_FLOAT64 = 7
TYPE_INT64 = 8
TYPE_UINT64 = 9
TYPE_VARINT = 10

_TYPE_SIZE = {
    TYPE_UINT8: 1, TYPE_INT16: 2, TYPE_UINT16: 2,
    TYPE_INT32: 4, TYPE_UINT32: 4, TYPE_FLOAT32: 4,
    TYPE_FLOAT64: 8, TYPE_INT64: 8, TYPE_UINT64: 8,
}

_TYPE_STRUCT = {
    TYPE_UINT8: 'B', TYPE_INT16: 'h', TYPE_UINT16: 'H',
    TYPE_INT32: 'i', TYPE_UINT32: 'I', TYPE_FLOAT32: 'f',
    TYPE_FLOAT64: 'd', TYPE_INT64: 'q', TYPE_UINT64: 'Q',
}


def serialize_bitmask(root):
    """BFS 순회로 쿼드트리를 비트마스크 바이트로 직렬화.

    Returns:
        (bitmask_bytes, leaf_count): 팩킹된 비트마스크와 리프 수.
    """
    current_level = [root]
    bitmask_list = []
    leaf_count = 0

    while current_level:
        next_level = []
        level_masks = []

        for node in current_level:
            mask = 0
            for key in range(4):
                if key in node.children:
                    mask |= (8 >> key)
                    next_level.append(node.children[key])
            level_masks.append(mask)

        if sum(level_masks) == 0:
            leaf_count = len(current_level)
            break

        bitmask_list.extend(level_masks)
        current_level = next_level

    if leaf_count == 0:
        leaf_count = len(current_level) if current_level else 0

    bitmask_bytes = bytearray()
    for i in range(0, len(bitmask_list), 2):
        first = bitmask_list[i]
        second = bitmask_list[i + 1] if i + 1 < len(bitmask_list) else 0
        bitmask_bytes.append((first << 4) | second)

    return bytes(bitmask_bytes), leaf_count


def _encode_field_schema(fields):
    """Field schema를 바이트로 인코딩."""
    buf = bytearray()
    for f in fields:
        name_bytes = f['name'].encode('utf-8')
        buf.append(f['type'])
        buf.append(f.get('offset', 0))
        buf.extend(struct.pack('<H', len(name_bytes)))
        buf.extend(name_bytes)
    return bytes(buf)


def _write_qbt_header(bitmask_bytes, values_bytes, zoom, flags,
                       crs=4326, origin_x=0.0, origin_y=0.0,
                       extent_x=0.0, extent_y=0.0, entry_size=0,
                       fields=None, metadata_bytes=None,
                       compress_bitmask=True):
    """128B+ QBT 헤더 생성.

    Returns:
        (header_bytes, stored_bitmask, header_size)
    """
    field_schema_bytes = _encode_field_schema(fields) if fields else b''
    header_size = 128 + len(field_schema_bytes)

    if compress_bitmask:
        stored_bitmask = gzip.compress(bitmask_bytes)
    else:
        stored_bitmask = bitmask_bytes
        flags |= 0x4  # bit 2: raw bitmask
    bitmask_length = len(stored_bitmask)
    values_offset = header_size + bitmask_length
    values_length = len(values_bytes)

    metadata_offset = 0
    metadata_length = 0
    if metadata_bytes:
        metadata_offset = values_offset + values_length
        metadata_length = len(metadata_bytes)

    index_hash = hashlib.sha256(bitmask_bytes).digest()

    header = bytearray(128)
    # magic
    header[0:4] = b'QBT\x01'
    # version
    struct.pack_into('<H', header, 4, 1)
    # header_size
    struct.pack_into('<H', header, 6, header_size)
    # flags
    struct.pack_into('<I', header, 8, flags)
    # zoom
    header[12] = zoom
    # reserved byte
    header[13] = 0
    # crs
    struct.pack_into('<H', header, 14, crs)
    # origin_x, origin_y
    struct.pack_into('<d', header, 16, origin_x)
    struct.pack_into('<d', header, 24, origin_y)
    # extent_x, extent_y
    struct.pack_into('<d', header, 32, extent_x)
    struct.pack_into('<d', header, 40, extent_y)
    # bitmask_length
    struct.pack_into('<Q', header, 48, bitmask_length)
    # values_offset
    struct.pack_into('<Q', header, 56, values_offset)
    # values_length
    struct.pack_into('<Q', header, 64, values_length)
    # metadata_offset, metadata_length
    struct.pack_into('<Q', header, 72, metadata_offset)
    struct.pack_into('<Q', header, 80, metadata_length)
    # entry_size
    struct.pack_into('<I', header, 88, entry_size)
    # field_count
    struct.pack_into('<H', header, 92, len(fields) if fields else 0)
    # index_hash (32 bytes at offset 94)
    header[94:126] = index_hash
    # reserved (2 bytes at offset 126)
    header[126:128] = b'\x00\x00'

    return bytes(header) + field_schema_bytes, stored_bitmask, header_size


def write_qbt_fixed(output_path, bitmask_bytes, values_bytes,
                    zoom, crs=4326, origin_x=0.0, origin_y=0.0,
                    extent_x=0.0, extent_y=0.0, entry_size=4,
                    fields=None, metadata=None, compress_bitmask=True):
    """Fixed-entry row 모드 QBT 파일 생성.

    Args:
        bitmask_bytes: serialize_bitmask()의 결과.
        values_bytes: leaf_count × entry_size 바이트의 값 데이터.
        fields: [{'type': TYPE_FLOAT32, 'offset': 0, 'name': 'value'}, ...]
    """
    flags = 0x1  # bit0=1 (fixed), bit1=0 (row)
    metadata_bytes = metadata.encode('utf-8') if isinstance(metadata, str) else metadata

    header_bytes, stored_bitmask, _ = _write_qbt_header(
        bitmask_bytes, values_bytes, zoom, flags,
        crs, origin_x, origin_y, extent_x, extent_y,
        entry_size, fields, metadata_bytes,
        compress_bitmask=compress_bitmask)

    with open(output_path, 'wb') as f:
        f.write(header_bytes)
        f.write(stored_bitmask)
        f.write(values_bytes)
        if metadata_bytes:
            f.write(metadata_bytes)


def write_qbt_columnar(output_path, bitmask_bytes, columns, leaf_count,
                       zoom, crs=4326, origin_x=0.0, origin_y=0.0,
                       extent_x=0.0, extent_y=0.0,
                       fields=None, metadata=None, compress=True,
                       compress_bitmask=True):
    """Fixed-entry columnar 모드 QBT 파일 생성.

    Args:
        bitmask_bytes: serialize_bitmask()의 결과.
        columns: list of (type_code, values) — varint이면 list[int], 고정이면 list[number].
        leaf_count: 리프 수.
        fields: [{'type': TYPE_VARINT, 'offset': 0, 'name': 'total'}, ...]
    """
    # Serialize columns
    values_io = BytesIO()
    for type_code, values in columns:
        if len(values) != leaf_count:
            raise ValueError(f"Column length {len(values)} != leaf_count {leaf_count}")
        if type_code == TYPE_VARINT:
            for v in values:
                write_varint(values_io, v)
        else:
            fmt = '<' + _TYPE_STRUCT[type_code]
            for v in values:
                values_io.write(struct.pack(fmt, v))

    values_bytes = values_io.getvalue()

    flags = 0x3  # bit0=1 (fixed), bit1=1 (columnar)
    metadata_bytes = metadata.encode('utf-8') if isinstance(metadata, str) else metadata

    header_bytes, stored_bitmask, _ = _write_qbt_header(
        bitmask_bytes, values_bytes, zoom, flags,
        crs, origin_x, origin_y, extent_x, extent_y,
        0, fields, metadata_bytes,
        compress_bitmask=compress_bitmask)  # entry_size=0 for columnar

    content = header_bytes + stored_bitmask + values_bytes
    if metadata_bytes:
        content += metadata_bytes

    if compress:
        with open(output_path, 'wb') as f:
            f.write(gzip.compress(content))
    else:
        with open(output_path, 'wb') as f:
            f.write(content)


def write_qbt_variable(output_path, root, tile_entries=None,
                       zoom=None, crs=4326, origin_x=-180.0, origin_y=90.0,
                       extent_x=360.0, extent_y=180.0, metadata=None):
    """Variable-entry 모드 QBT 단일 파일 생성 (인덱스 + 타일 데이터).

    Args:
        root: 쿼드트리 루트 노드.
        tile_entries: index_tile_folder()의 결과 리스트.
            [(quadkey_int64, filepath, offset, length, run_length), ...]
            주어지면 타일 데이터를 values section에 연결.
    """
    # BFS → bitmask + varints
    current_level = [root]
    bitmask_list = []
    run_lengths = []
    lengths = []
    offsets_list = []

    while current_level:
        next_level = []
        level_masks = []
        for node in current_level:
            mask = 0
            for key in range(4):
                if key in node.children:
                    mask |= (8 >> key)
                    next_level.append(node.children[key])
            level_masks.append(mask)
            run_lengths.append(node.run_length)
            lengths.append(node.length)
            offsets_list.append(node.offset)

        if sum(level_masks) == 0:
            break
        bitmask_list.extend(level_masks)
        current_level = next_level

    # Pack bitmask
    bitmask_bytes = bytearray()
    for i in range(0, len(bitmask_list), 2):
        first = bitmask_list[i]
        second = bitmask_list[i + 1] if i + 1 < len(bitmask_list) else 0
        bitmask_bytes.append((first << 4) | second)
    bitmask_bytes = bytes(bitmask_bytes)

    # Serialize varints (columnar: run_lengths, lengths, offsets)
    varint_io = BytesIO()
    for val in run_lengths:
        write_varint(varint_io, val)
    for val in lengths:
        write_varint(varint_io, val)
    for i in range(len(offsets_list)):
        if i > 0 and offsets_list[i] == offsets_list[i - 1] + lengths[i - 1]:
            write_varint(varint_io, 0)
        else:
            write_varint(varint_io, offsets_list[i] + 1)
    varint_bytes = varint_io.getvalue()

    # Variable-entry: 4B prefix + bitmask + varints 합쳐서 gzip
    # 4B prefix = bitmask byte length (big-endian, for deserializeQuadtreeIndex compatibility)
    index_bytes = len(bitmask_bytes).to_bytes(4, byteorder="big") + bitmask_bytes + varint_bytes
    compressed_index = gzip.compress(index_bytes)

    flags = 0x0  # bit0=0 (variable), bit1=0 (row)
    metadata_bytes = metadata.encode('utf-8') if isinstance(metadata, str) else metadata

    field_schema_bytes = b''
    header_size = 128
    index_hash = hashlib.sha256(index_bytes).digest()

    # Compute values section size
    values_offset = header_size + len(compressed_index)
    values_length = 0
    if tile_entries:
        values_length = sum(length for _, _, _, length, _ in tile_entries)

    metadata_offset = 0
    metadata_length = 0
    if metadata_bytes:
        metadata_offset = values_offset + values_length
        metadata_length = len(metadata_bytes)

    header = bytearray(128)
    header[0:4] = b'QBT\x01'
    struct.pack_into('<H', header, 4, 1)
    struct.pack_into('<H', header, 6, header_size)
    struct.pack_into('<I', header, 8, flags)
    header[12] = zoom or 0
    struct.pack_into('<H', header, 14, crs)
    struct.pack_into('<d', header, 16, origin_x)
    struct.pack_into('<d', header, 24, origin_y)
    struct.pack_into('<d', header, 32, extent_x)
    struct.pack_into('<d', header, 40, extent_y)
    struct.pack_into('<Q', header, 48, len(compressed_index))
    struct.pack_into('<Q', header, 56, values_offset)
    struct.pack_into('<Q', header, 64, values_length)
    struct.pack_into('<Q', header, 72, metadata_offset)
    struct.pack_into('<Q', header, 80, metadata_length)
    struct.pack_into('<I', header, 88, 0)  # entry_size = 0
    struct.pack_into('<H', header, 92, 0)  # field_count = 0
    header[94:126] = index_hash
    header[126:128] = b'\x00\x00'

    with open(output_path, 'wb') as f:
        f.write(bytes(header))
        f.write(compressed_index)
        # Write tile data in quadkey order
        if tile_entries:
            for _, filepath, _, length, _ in tile_entries:
                with open(filepath, 'rb') as tf:
                    f.write(tf.read())
        if metadata_bytes:
            f.write(metadata_bytes)


def read_qbt_header(filepath_or_bytes):
    """QBT 파일 헤더를 파싱하여 dict로 반환.

    Args:
        filepath_or_bytes: 파일 경로(str) 또는 bytes/bytearray.

    Returns:
        dict with header fields + 'fields' list.
    """
    if isinstance(filepath_or_bytes, (str, os.PathLike)):
        with open(filepath_or_bytes, 'rb') as f:
            raw = f.read(1024)  # 충분히 읽어서 field schema 포함
    else:
        raw = filepath_or_bytes

    # gzip인 경우 해제
    if raw[:2] == b'\x1f\x8b':
        raw = gzip.decompress(raw if isinstance(filepath_or_bytes, (bytes, bytearray))
                              else open(filepath_or_bytes, 'rb').read())

    if raw[:4] != b'QBT\x01':
        raise ValueError(f"Invalid magic: {raw[:4]}")

    h = {}
    h['magic'] = raw[:4]
    h['version'] = struct.unpack_from('<H', raw, 4)[0]
    h['header_size'] = struct.unpack_from('<H', raw, 6)[0]
    h['flags'] = struct.unpack_from('<I', raw, 8)[0]
    h['is_fixed'] = bool(h['flags'] & 0x1)
    h['is_columnar'] = bool(h['flags'] & 0x2)
    h['zoom'] = raw[12]
    h['crs'] = struct.unpack_from('<H', raw, 14)[0]
    h['origin_x'] = struct.unpack_from('<d', raw, 16)[0]
    h['origin_y'] = struct.unpack_from('<d', raw, 24)[0]
    h['extent_x'] = struct.unpack_from('<d', raw, 32)[0]
    h['extent_y'] = struct.unpack_from('<d', raw, 40)[0]
    h['bitmask_length'] = struct.unpack_from('<Q', raw, 48)[0]
    h['values_offset'] = struct.unpack_from('<Q', raw, 56)[0]
    h['values_length'] = struct.unpack_from('<Q', raw, 64)[0]
    h['metadata_offset'] = struct.unpack_from('<Q', raw, 72)[0]
    h['metadata_length'] = struct.unpack_from('<Q', raw, 80)[0]
    h['entry_size'] = struct.unpack_from('<I', raw, 88)[0]
    h['field_count'] = struct.unpack_from('<H', raw, 92)[0]
    h['index_hash'] = raw[94:126].hex()

    # Parse field schema
    h['fields'] = []
    offset = 128
    for _ in range(h['field_count']):
        ftype = raw[offset]
        foffset = raw[offset + 1]
        name_len = struct.unpack_from('<H', raw, offset + 2)[0]
        name = raw[offset + 4:offset + 4 + name_len].decode('utf-8')
        h['fields'].append({'type': ftype, 'offset': foffset, 'name': name})
        offset += 4 + name_len

    return h


# ============================================================
# High-level unified builder
# ============================================================

def build(output_path, folder=None, geotiff=None,
          coords=None, quadkeys=None,
          columns=None, values=None,
          zoom=None, cell_size=None,
          crs=4326, origin_x=-180.0, origin_y=90.0,
          extent_x=360.0, extent_y=180.0,
          entry_size=4, fields=None, ext=".png", metadata=None,
          nodata=None, compress=True, compress_bitmask=True):
    """QBT 파일 생성 — 인자 조합으로 모드 자동 판단.

    GeoTIFF 변환:
        qbt.build("output.qbt", geotiff="input.tif")

    Variable-entry (타일 아카이브):
        qbt.build("output.qbt", folder="tiles/")

    Columnar (격자 데이터, 전체 다운로드):
        qbt.build("out.qbt.gz", coords=[(x,y),...], columns={"pop": [...]}, zoom=13, crs=5179, ...)

    Fixed row (격자 데이터, Range Request):
        qbt.build("out.qbt", coords=[(x,y),...], values=[...], zoom=16, ...)

    Args:
        output_path: 출력 파일 경로.
        folder: 타일 폴더 (variable-entry 모드).
        coords: [(x, y), ...] 좌표 리스트 — 내부에서 quadkey로 변환.
        quadkeys: [int, ...] quadkey int64 리스트 — coords 대신 직접 제공.
        columns: {"name": [values], ...} 컬럼 딕셔너리 (columnar 모드).
        values: 값 리스트 또는 bytes (fixed row 모드).
        zoom: 줌 레벨.
        crs: EPSG 코드 (기본 4326).
        origin_x, origin_y: 격자 원점.
        extent_x, extent_y: 격자 범위.
        entry_size: 엔트리 크기 (fixed row, 기본 4).
        fields: 필드 스키마 리스트.
        ext: 타일 확장자 (기본 ".png").
        metadata: JSON 메타데이터 문자열.
        compress: 전체 gzip 압축 (columnar, 기본 True).
        compress_bitmask: bitmask gzip 압축 (기본 True).
    """
    import math

    # GeoTIFF → extract coords, values, cell_size, crs automatically
    if geotiff is not None:
        try:
            import rasterio
            import numpy as np
        except ImportError:
            raise ImportError(
                "rasterio and numpy are required for GeoTIFF conversion. "
                "Install with: pip install rasterio numpy"
            )
        with rasterio.open(geotiff) as src:
            file_nodata = src.nodata
            transform = src.transform
            if src.crs is None:
                raise ValueError(
                    f"GeoTIFF has no CRS (coordinate reference system). "
                    f"Please provide a georeferenced file or specify crs= manually."
                )
            geotiff_crs = src.crs.to_epsg()
            if geotiff_crs is None:
                # WKT but no EPSG — try to detect WGS84
                if 'WGS 84' in src.crs.to_wkt():
                    geotiff_crs = 4326
                else:
                    raise ValueError(
                        f"Could not determine EPSG code from CRS: {src.crs.to_wkt()[:100]}. "
                        f"Please specify crs= manually."
                    )

            # Read all bands
            band_count = src.count
            band_names = list(src.descriptions) if any(src.descriptions) else None
            arrays = []
            for b in range(1, band_count + 1):
                arrays.append(src.read(b))

            # Find valid (non-nodata) cells
            # User-specified nodata overrides file's nodata
            effective_nodata = nodata if nodata is not None else file_nodata
            if effective_nodata is not None:
                mask = arrays[0] != effective_nodata
            else:
                mask = np.ones(arrays[0].shape, dtype=bool)

            rows, cols_arr = np.where(mask)
            n_valid = len(rows)

            if n_valid == 0:
                raise ValueError(f"No valid cells found in {geotiff}")

            # Cell centers
            pixel_w = abs(transform[0])
            pixel_h = abs(transform[4])
            xs = transform[2] + cols_arr * transform[0] + transform[0] / 2
            ys = transform[5] + rows * transform[4] + transform[4] / 2

            import warnings
            warnings.warn(
                f"GeoTIFF: {geotiff} → {n_valid:,} valid cells out of "
                f"{arrays[0].size:,} ({n_valid/arrays[0].size*100:.1f}%), "
                f"CRS=EPSG:{geotiff_crs}, pixel={pixel_w}×{pixel_h}",
                stacklevel=2,
            )

            coords = list(zip(xs.tolist(), ys.tolist()))
            crs = geotiff_crs or crs

            if cell_size is None:
                cell_size = pixel_w

            # Auto-calculate origin/extent from GeoTIFF bounds
            bounds = src.bounds  # left, bottom, right, top
            data_w = bounds.right - bounds.left
            data_h = bounds.top - bounds.bottom
            import math

            if crs == 4326:
                # WGS84: origin = NW corner (top-left), Y decreases downward
                origin_x = math.floor(bounds.left / cell_size) * cell_size
                origin_y = math.ceil(bounds.top / cell_size) * cell_size

                # X/Y extents independently (non-square allowed)
                zoom_x = math.ceil(math.log2((bounds.right - origin_x) / cell_size))
                zoom_y = math.ceil(math.log2((origin_y - bounds.bottom) / cell_size))
                extent_x = cell_size * (2 ** zoom_x)
                extent_y = cell_size * (2 ** zoom_y)

                # Ensure extent covers all data
                while origin_x + extent_x < bounds.right:
                    zoom_x += 1
                    extent_x = cell_size * (2 ** zoom_x)
                while origin_y - extent_y > bounds.bottom:
                    zoom_y += 1
                    extent_y = cell_size * (2 ** zoom_y)
            else:
                # Custom CRS: origin = SW corner (bottom-left), Y increases upward
                origin_x = math.floor(bounds.left / cell_size) * cell_size
                origin_y = math.floor(bounds.bottom / cell_size) * cell_size
                data_range = max(data_w, data_h)

                zoom_needed = math.ceil(math.log2(data_range / cell_size))
                auto_extent = cell_size * (2 ** zoom_needed)
                while origin_x + auto_extent < bounds.right:
                    zoom_needed += 1
                    auto_extent = cell_size * (2 ** zoom_needed)
                while origin_y + auto_extent < bounds.top:
                    zoom_needed += 1
                    auto_extent = cell_size * (2 ** zoom_needed)
                extent_x = auto_extent
                extent_y = auto_extent

            _NUMPY_TO_QBT = {
                np.dtype('uint8'): TYPE_UINT8,
                np.dtype('int16'): TYPE_INT16,
                np.dtype('uint16'): TYPE_UINT16,
                np.dtype('int32'): TYPE_INT32,
                np.dtype('uint32'): TYPE_UINT32,
                np.dtype('float32'): TYPE_FLOAT32,
                np.dtype('float64'): TYPE_FLOAT64,
                np.dtype('int64'): TYPE_INT64,
                np.dtype('uint64'): TYPE_UINT64,
            }
            dtype = arrays[0].dtype
            type_code = _NUMPY_TO_QBT.get(dtype,
                TYPE_INT32 if np.issubdtype(dtype, np.integer) else TYPE_FLOAT32)
            type_size = _TYPE_SIZE[type_code]

            if band_count == 1:
                # Single band → fixed row mode
                values = arrays[0][rows, cols_arr].tolist()
                if fields is None:
                    name = (band_names[0] if band_names and band_names[0] else 'value')
                    fields = [{'type': type_code, 'name': name}]
                    entry_size = type_size
            else:
                # Multiple bands → fixed row mode (interleaved)
                # Each entry = [band1, band2, ...] concatenated
                if fields is None:
                    field_list = []
                    for b in range(band_count):
                        name = (band_names[b] if band_names and band_names[b] else f'band{b+1}')
                        field_list.append({'type': type_code, 'offset': b * type_size, 'name': name})
                    fields = field_list
                    entry_size = type_size * band_count

                # Interleave band values into flat values list
                band_vals = [arrays[b][rows, cols_arr] for b in range(band_count)]
                values_bytes_io = BytesIO()
                fmt = '<' + _TYPE_STRUCT[type_code]
                for i in range(n_valid):
                    for b in range(band_count):
                        values_bytes_io.write(struct.pack(fmt, band_vals[b][i]))
                values = values_bytes_io.getvalue()  # raw bytes, not list

    # Auto-calculate origin/extent from coords + cell_size (custom CRS only)
    if coords is not None and cell_size is not None and crs != 4326:
        xs = [c[0] for c in coords]
        ys = [c[1] for c in coords]
        min_x, max_x = min(xs), max(xs)
        min_y, max_y = min(ys), max(ys)
        data_range = max(max_x - min_x, max_y - min_y) + cell_size  # +1 cell padding

        # extent = cell_size × 2^zoom (smallest power of 2 that covers the data)
        zoom_needed = math.ceil(math.log2(data_range / cell_size))
        auto_extent = cell_size * (2 ** zoom_needed)

        # Center the grid on the data
        cx = (min_x + max_x) / 2
        cy = (min_y + max_y) / 2
        auto_origin_x = cx - auto_extent / 2
        auto_origin_y = cy - auto_extent / 2

        # Align origin to cell boundaries
        auto_origin_x = math.floor(auto_origin_x / cell_size) * cell_size
        auto_origin_y = math.floor(auto_origin_y / cell_size) * cell_size

        # Use auto values only if user didn't explicitly set them
        if origin_x == -180.0 and origin_y == 90.0:
            origin_x = auto_origin_x
            origin_y = auto_origin_y
        if extent_x == 360.0 and extent_y == 180.0:
            extent_x = auto_extent
            extent_y = auto_extent

    # cell_size → zoom 자동 계산
    if cell_size is not None and zoom is None:
        zoom = round(math.log2(max(extent_x, extent_y) / cell_size))
        if abs(extent_x / (2 ** zoom) - cell_size) > cell_size * 0.01:
            raise ValueError(
                f"cell_size={cell_size} does not divide extent_x={extent_x} into a power of 2. "
                f"Nearest zoom={zoom} gives cell_size={extent_x / (2 ** zoom):.6f}"
            )
    elif cell_size is not None and zoom is not None:
        raise ValueError("Provide either zoom or cell_size, not both")

    import json as _json

    def _ensure_metadata(metadata, extra):
        """Merge extra fields into metadata JSON string."""
        if metadata is None:
            meta = {}
        elif isinstance(metadata, str):
            meta = _json.loads(metadata)
        else:
            meta = dict(metadata)
        meta.update(extra)
        return _json.dumps(meta)

    if folder is not None:
        # Variable-entry: 타일 아카이브
        tile_entries = index_tile_folder(folder, ext)
        if not tile_entries:
            raise ValueError(f"No tiles found in {folder}")
        root = build_quadtree(tile_entries)
        # quadkey_int64 = 0b11 prefix + 2 bits per zoom level
        # bit_length = 2 + 2*zoom → zoom = (bit_length - 2) / 2 = bit_length/2 - 1
        max_zoom = max((e[0].bit_length() // 2) - 1 for e in tile_entries) if zoom is None else zoom

        # Auto-detect MVT vector layer names
        meta_extra = {}
        if ext in ('.mvt', '.pbf'):
            vector_layers = _extract_mvt_layer_names(folder, ext)
            if vector_layers:
                meta_extra["vector_layers"] = [{"id": name} for name in vector_layers]

        # data_bounds from leaf tiles (deepest zoom)
        leaf_entries = [e for e in tile_entries if (e[0].bit_length() // 2) - 1 == max_zoom]
        if leaf_entries:
            zxys = [quadkey_int64_to_zxy(e[0]) for e in leaf_entries]
            min_x = min(x for _, x, _ in zxys)
            max_x = max(x for _, x, _ in zxys)
            min_y = min(y for _, _, y in zxys)
            max_y = max(y for _, _, y in zxys)
            n = 1 << max_zoom
            meta_extra["data_bounds"] = {
                "west": (min_x / n) * 360 - 180,
                "east": ((max_x + 1) / n) * 360 - 180,
                "north": _tile2lat(min_y, n),
                "south": _tile2lat(max_y + 1, n),
            }

        if meta_extra:
            metadata = _ensure_metadata(metadata, meta_extra)

        write_qbt_variable(output_path, root, tile_entries=tile_entries,
                          zoom=max_zoom, crs=crs,
                          origin_x=origin_x, origin_y=origin_y,
                          extent_x=extent_x, extent_y=extent_y,
                          metadata=metadata)
        return tile_entries

    # coords → quadkeys 변환
    if coords is not None and quadkeys is None:
        if zoom is None:
            raise ValueError("zoom is required when using coords")
        import warnings

        if crs == 4326 or crs == 3857:
            # WGS84: origin is NW corner, Y goes down (matches reader's latToRow)
            # row = (originY - lat) / pixelDeg, col = (lon - originX) / pixelDeg
            pixel_deg = extent_x / (2 ** zoom)
            actual_cell = pixel_deg
            warnings.warn(
                f"Coordinates will be snapped to {actual_cell}×{actual_cell} grid cells "
                f"(zoom={zoom}, extent_x={extent_x}). "
                f"Each coordinate maps to the cell center.",
                stacklevel=2,
            )

            def _wgs84_to_quadkey(lon, lat):
                col = int((lon - origin_x) / pixel_deg)
                row = int((origin_y - lat) / pixel_deg)
                # row/col → quadkey with 0b11 prefix
                qk = 3
                for i in reversed(range(zoom)):
                    rb = (row >> i) & 1
                    cb = (col >> i) & 1
                    qk = (qk << 2) | (rb << 1) | cb
                return qk

            quadkeys = [_wgs84_to_quadkey(x, y) for x, y in coords]
        else:
            # Custom CRS: origin is SW corner, Y goes up
            extent = extent_x  # square grid assumed
            actual_cell = extent / (2 ** zoom)
            warnings.warn(
                f"Coordinates will be snapped to {actual_cell}×{actual_cell} grid cells "
                f"(zoom={zoom}, extent={extent}). "
                f"Each coordinate maps to the cell center.",
                stacklevel=2,
            )
            quadkeys = [encode_custom_quadkey(x, y, zoom, origin_x, origin_y, extent)
                        for x, y in coords]

    if quadkeys is None:
        raise ValueError("One of folder, coords, or quadkeys is required")

    # Validate column types early
    if columns is not None:
        for name, vals in columns.items():
            if not all(isinstance(v, (int, float)) for v in vals):
                raise ValueError(
                    f"Column '{name}' contains non-numeric values. "
                    f"Only int and float are supported."
                )

    # Detect duplicate quadkeys (multiple points in same grid cell)
    if (columns is not None or values is not None) and len(quadkeys) != len(set(quadkeys)):
        import warnings
        from collections import Counter
        qk_counts = Counter(quadkeys)
        n_dups = sum(1 for c in qk_counts.values() if c > 1)
        total_merged = sum(c for c in qk_counts.values() if c > 1)

        if columns is not None:
            # Check each column: numeric → sum, non-numeric → must be identical
            merged_columns = {}
            for name, vals in columns.items():
                is_numeric = all(isinstance(v, (int, float)) for v in vals)
                if is_numeric:
                    # Sum values per grid cell
                    agg = {}
                    for qk, v in zip(quadkeys, vals):
                        agg[qk] = agg.get(qk, 0) + v
                    merged_columns[name] = agg
                else:
                    # Non-numeric: must be identical within each cell
                    agg = {}
                    for qk, v in zip(quadkeys, vals):
                        if qk in agg:
                            if agg[qk] != v:
                                raise ValueError(
                                    f"Column '{name}' has conflicting non-numeric values "
                                    f"in the same grid cell: {agg[qk]!r} vs {v!r}"
                                )
                        else:
                            agg[qk] = v
                    merged_columns[name] = agg

            warnings.warn(
                f"{n_dups} grid cells contain multiple points ({total_merged} total). "
                f"Numeric columns summed.",
                stacklevel=2,
            )

            # Rebuild quadkeys and columns from merged data
            unique_qks = sorted(merged_columns[list(columns.keys())[0]].keys())
            quadkeys = unique_qks
            columns = {name: [agg[qk] for qk in unique_qks] for name, agg in merged_columns.items()}

        elif values is not None:
            if isinstance(values, (bytes, bytearray)):
                raise ValueError(
                    f"{n_dups} grid cells contain multiple points, "
                    f"but raw bytes values cannot be merged. "
                    f"Pre-aggregate your data or use list values."
                )
            # Sum numeric values
            is_numeric = all(isinstance(v, (int, float)) for v in values)
            if not is_numeric:
                raise ValueError(
                    f"{n_dups} grid cells contain multiple points with non-numeric values."
                )
            agg = {}
            for qk, v in zip(quadkeys, values):
                agg[qk] = agg.get(qk, 0) + v
            warnings.warn(
                f"{n_dups} grid cells contain multiple points ({total_merged} total). "
                f"Values summed.",
                stacklevel=2,
            )
            unique_qks = sorted(agg.keys())
            quadkeys = unique_qks
            values = [agg[qk] for qk in unique_qks]

    if columns is not None:
        # Columnar 모드
        if zoom is None:
            raise ValueError("zoom is required for columnar mode")

        # quadkey → quadtree
        quadkey_info = [(qk, "", 0, 0, 1) for qk in quadkeys]
        root = build_quadtree(quadkey_info)
        bitmask_bytes, leaf_count = serialize_bitmask(root)

        # 정렬: quadkey 순서로 values 정렬
        sorted_indices = sorted(range(len(quadkeys)), key=lambda i: quadkeys[i])

        # 타입 자동 추론 + 컬럼 구축
        col_list = []
        field_list = []
        for name, vals in columns.items():
            sorted_vals = [vals[i] for i in sorted_indices]
            if not all(isinstance(v, (int, float)) for v in vals):
                raise ValueError(
                    f"Column '{name}' contains non-numeric values. "
                    f"Only int and float are supported."
                )
            if all(isinstance(v, int) for v in vals):
                type_code = TYPE_VARINT
            else:
                type_code = TYPE_FLOAT32
            col_list.append((type_code, sorted_vals))
            field_list.append({'type': type_code, 'offset': 0, 'name': name})

        # Add data_bounds to metadata
        if coords is not None:
            xs = [c[0] for c in coords]
            ys = [c[1] for c in coords]
            metadata = _ensure_metadata(metadata, {
                "data_bounds": {"west": min(xs), "south": min(ys), "east": max(xs), "north": max(ys)}
            })

        write_qbt_columnar(output_path, bitmask_bytes, col_list, leaf_count,
                          zoom=zoom, crs=crs,
                          origin_x=origin_x, origin_y=origin_y,
                          extent_x=extent_x, extent_y=extent_y,
                          fields=fields or field_list,
                          metadata=metadata, compress=compress,
                          compress_bitmask=compress_bitmask)

    elif values is not None:
        # Fixed row 모드
        if zoom is None:
            raise ValueError("zoom is required for fixed row mode")

        quadkey_info = [(qk, "", 0, 0, 1) for qk in quadkeys]
        root = build_quadtree(quadkey_info)
        bitmask_bytes, leaf_count = serialize_bitmask(root)

        sorted_indices = sorted(range(len(quadkeys)), key=lambda i: quadkeys[i])

        # values를 bytes로 변환
        if isinstance(values, (bytes, bytearray)):
            # Raw bytes: reorder by entry_size chunks according to sorted_indices
            es = entry_size or (len(values) // len(quadkeys))
            values_bytes = b''.join(values[i*es:(i+1)*es] for i in sorted_indices)
        else:
            # list of numbers → pack as bytes
            if fields and len(fields) == 1:
                fmt = '<' + _TYPE_STRUCT.get(fields[0]['type'], 'f')
            else:
                fmt = '<f'  # default float32
            sorted_vals = [values[i] for i in sorted_indices]
            values_bytes = b''.join(struct.pack(fmt, v) for v in sorted_vals)

        # Add data_bounds to metadata
        if coords is not None:
            xs = [c[0] for c in coords]
            ys = [c[1] for c in coords]
            metadata = _ensure_metadata(metadata, {
                "data_bounds": {"west": min(xs), "south": min(ys), "east": max(xs), "north": max(ys)}
            })

        write_qbt_fixed(output_path, bitmask_bytes, values_bytes,
                       zoom=zoom, crs=crs,
                       origin_x=origin_x, origin_y=origin_y,
                       extent_x=extent_x, extent_y=extent_y,
                       entry_size=entry_size, fields=fields,
                       metadata=metadata, compress_bitmask=compress_bitmask)

    else:
        raise ValueError("One of folder, columns, or values is required")
