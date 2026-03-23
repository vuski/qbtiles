"""
QBTiles - Quadtree Bitmask Tile Index

클라우드 최적화 타일 아카이브 인덱스 포맷.
쿼드트리 비트마스크 인덱싱으로 타일 ID를 개별 저장하지 않고
BFS 순회로 모든 quadkey를 복원한다.
"""

import os
import io
import gzip
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


def deserialize_quadtree_index(filepath):
    """gzip 압축된 바이너리 인덱스 파일을 읽어 엔트리 리스트로 복원한다."""
    with gzip.open(filepath, "rb") as f:
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
