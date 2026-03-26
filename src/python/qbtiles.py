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


def write_qbt_variable(output_path, root, data_path=None,
                       zoom=None, crs=4326, origin_x=-180.0, origin_y=90.0,
                       extent_x=360.0, extent_y=180.0, metadata=None):
    """Variable-entry 모드 QBT 파일 생성 (타일 아카이브 인덱스).

    Args:
        root: 쿼드트리 루트 노드.
        data_path: 외부 데이터 파일 경로 (inline이 아닌 경우).
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

    # bitmask_length = compressed index (bitmask + varints)
    # values_offset/values_length = 0 (외부 데이터 파일)
    field_schema_bytes = b''
    header_size = 128
    index_hash = hashlib.sha256(index_bytes).digest()

    metadata_offset = 0
    metadata_length = 0
    if metadata_bytes:
        metadata_offset = header_size + len(compressed_index)
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
    struct.pack_into('<Q', header, 56, 0)  # values_offset = 0 (external)
    struct.pack_into('<Q', header, 64, 0)  # values_length = 0
    struct.pack_into('<Q', header, 72, metadata_offset)
    struct.pack_into('<Q', header, 80, metadata_length)
    struct.pack_into('<I', header, 88, 0)  # entry_size = 0
    struct.pack_into('<H', header, 92, 0)  # field_count = 0
    header[94:126] = index_hash
    header[126:128] = b'\x00\x00'

    with open(output_path, 'wb') as f:
        f.write(bytes(header))
        f.write(compressed_index)
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
