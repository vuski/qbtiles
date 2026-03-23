"""
예제 2: 임의 좌표계에서 QBTiles 사용

XYZ 웹 타일이 아닌 경우에도 QBTiles를 사용할 수 있다.
핵심은 좌표 공간을 직접 쿼드트리로 분할하는 것이다.

사용자는 데이터의 bbox(좌하단, 우상단)와 줌레벨만 지정하면 된다.
fit_grid()가 자동으로 정수 좌표를 보장하는 격자 파라미터를 계산한다.
"""

import sys
import os
import math

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src", "python"))

import qbtiles as qbt


# ============================================================
# 격자 파라미터 자동 계산
# ============================================================

def fit_grid(min_x, min_y, max_x, max_y, zoom):
    """
    데이터 bbox를 포함하면서, 최대 줌레벨에서도 정수 좌표를 보장하는
    격자 파라미터(origin_x, origin_y, extent)를 계산한다.

    Args:
        min_x, min_y: 데이터 bbox 좌하단
        max_x, max_y: 데이터 bbox 우상단
        zoom: 분할 깊이

    Returns:
        origin_x, origin_y: 격자 원점 (좌하단, tile_size의 배수)
        extent: 한 변 길이 (tile_size × 2^zoom)
        tile_size: 최소 격자 크기 (정수)

    원리:
        extent / 2^zoom = tile_size (정수)이면,
        모든 줌레벨에서 타일 경계가 정수 좌표에 놓인다.
        origin을 tile_size 배수로 내림하여 bbox 좌하단을 포함시키고,
        extent가 bbox 우상단까지 커버하는지 확인한다.
    """
    n = 2 ** zoom
    data_range = max(max_x - min_x, max_y - min_y)

    # 최소 tile_size: 데이터 범위를 2^zoom으로 나눈 것의 올림 (최소 1)
    tile_size = max(1, math.ceil(data_range / n))

    # origin을 tile_size 배수로 내림 → bbox 좌하단 포함
    # extent가 bbox 우상단까지 커버할 때까지 tile_size 증가
    while True:
        extent = tile_size * n
        origin_x = math.floor(min_x / tile_size) * tile_size
        origin_y = math.floor(min_y / tile_size) * tile_size
        if origin_x + extent >= max_x and origin_y + extent >= max_y:
            break
        tile_size += 1

    return origin_x, origin_y, extent, tile_size


# ============================================================
# 좌표 ↔ 쿼드키 변환
# ============================================================

def encode_quadkey(x, y, zoom, origin_x, origin_y, extent):
    """임의 좌표계의 (x, y)를 쿼드키 int64로 변환."""
    rel_x = x - origin_x
    rel_y = y - origin_y

    if not (0 <= rel_x < extent and 0 <= rel_y < extent):
        raise ValueError(f"Point ({x}, {y}) is out of bounds")

    tile_size = extent / (2 ** zoom)
    tile_x = int(rel_x // tile_size)
    tile_y = int(rel_y // tile_size)

    return qbt.tile_to_quadkey_int64(zoom, tile_x, tile_y)


def decode_quadkey(qk_int64, zoom, origin_x, origin_y, extent):
    """쿼드키 int64를 좌표계의 중심 좌표로 변환."""
    _, tile_x, tile_y = qbt.quadkey_int64_to_zxy(qk_int64)
    tile_size = extent / (2 ** zoom)
    x_center = origin_x + tile_x * tile_size + tile_size / 2
    y_center = origin_y + tile_y * tile_size + tile_size / 2
    return x_center, y_center


# ============================================================
# 예시: 가상의 투영 좌표계에서 격자 데이터 인덱싱
# ============================================================

import random
random.seed(42)

# 사용자가 아는 것: 데이터의 bbox와 원하는 줌레벨뿐
DATA_MIN_X = 120000
DATA_MIN_Y = 220000
DATA_MAX_X = 180000
DATA_MAX_Y = 280000
ZOOM = 10

# fit_grid가 정수 좌표를 보장하는 격자 파라미터를 자동 계산
origin_x, origin_y, extent, tile_size = fit_grid(
    DATA_MIN_X, DATA_MIN_Y, DATA_MAX_X, DATA_MAX_Y, ZOOM
)

print(f"=== 입력 ===")
print(f"  데이터 bbox: ({DATA_MIN_X}, {DATA_MIN_Y}) ~ ({DATA_MAX_X}, {DATA_MAX_Y})")
print(f"  줌레벨: {ZOOM}")
print()
print(f"=== fit_grid 결과 ===")
print(f"  원점 (좌하단): ({origin_x}, {origin_y})")
print(f"  extent: {extent}m  ({extent/1000:.1f}km)")
print(f"  격자 크기: {tile_size}m")
print(f"  격자 수: {2**ZOOM} × {2**ZOOM} = {(2**ZOOM)**2}")
print(f"  커버 영역: ({origin_x}, {origin_y}) ~ ({origin_x + extent}, {origin_y + extent})")
print()

# ============================================================
# 1단계: 가상 데이터 생성
# ============================================================
data_points = []
data_offset = 0

for i in range(50):
    x = random.randint(DATA_MIN_X, DATA_MAX_X - 1)
    y = random.randint(DATA_MIN_Y, DATA_MAX_Y - 1)

    # 격자 중심으로 스냅
    gx = (x // tile_size) * tile_size + tile_size // 2
    gy = (y // tile_size) * tile_size + tile_size // 2

    data_length = random.randint(100, 2000)
    data_points.append((gx, gy, data_offset, data_length))
    data_offset += data_length

print(f"데이터 포인트 {len(data_points)}개 생성")
print()

# ============================================================
# 2단계: 쿼드키 변환 및 쿼드트리 구축
# ============================================================
quadkey_info = []
seen_qk = set()

for x, y, offset, length in data_points:
    qk = encode_quadkey(x, y, ZOOM, origin_x, origin_y, extent)

    if qk in seen_qk:
        continue
    seen_qk.add(qk)

    quadkey_info.append((qk, "", offset, length, 1))

    cx, cy = decode_quadkey(qk, ZOOM, origin_x, origin_y, extent)
    print(f"  ({x}, {y}) → qk={qk} → decode=({cx:.0f}, {cy:.0f})")

quadkey_info.sort(key=lambda x: x[0])
print(f"\n고유 격자 셀: {len(quadkey_info)}개")
print()

# ============================================================
# 3단계: 직렬화 및 역직렬화 검증
# ============================================================
root = qbt.build_quadtree(quadkey_info)

output_path = os.path.join(os.path.dirname(__file__), "output_custom_index.gz")
qbt.write_tree_bitmask_to_single_file(root, output_path, verbose=True)

entries = qbt.deserialize_quadtree_index(output_path)
index_dict = qbt.build_quadkey_index_dict(entries)

print(f"\n복원된 엔트리: {len(entries)}개")

print("\n=== 검증 ===")
all_ok = True
verified_qk = set()
for x, y, offset, length in data_points:
    qk = encode_quadkey(x, y, ZOOM, origin_x, origin_y, extent)
    if qk in verified_qk:
        continue
    verified_qk.add(qk)
    if qk not in index_dict:
        print(f"  FAIL: ({x}, {y}) not found")
        all_ok = False
        continue
    e = index_dict[qk]
    if e["offset"] != offset or e["length"] != length:
        print(f"  FAIL: ({x}, {y}) offset/length mismatch")
        all_ok = False

if all_ok:
    print("  모든 포인트 검증 통과!")

# ============================================================
# 4단계: 좌표로 타일 조회
# ============================================================
print("\n=== 좌표 기반 타일 조회 ===")
query_x = 150000
query_y = 250000

qk = encode_quadkey(query_x, query_y, ZOOM, origin_x, origin_y, extent)
print(f"조회 좌표: ({query_x}, {query_y})")
print(f"쿼드키: {qk}")

if qk in index_dict:
    e = index_dict[qk]
    print(f"데이터 발견: offset={e['offset']}, length={e['length']}")
    print(f"→ Range: bytes={e['offset']}-{e['offset'] + e['length'] - 1}")
else:
    print("해당 격자에 데이터 없음")

# ============================================================
# 5단계: 클라이언트 디코딩 시뮬레이션
# ============================================================
# 클라이언트는 index.gz만 받으면 quadkey_int64 → (z, tile_x, tile_y)까지는 복원할 수 있다.
# 하지만 실제 좌표로 변환하려면 격자 메타데이터(origin, extent, zoom)가 필요하다.

print("\n=== 클라이언트 디코딩 시뮬레이션 ===")
print()

# 인덱스에서 엔트리를 하나 꺼내본다
sample_entry = entries[0]
qk_int = sample_entry["quadkey_int"]
z_decoded, tile_x, tile_y = qbt.quadkey_int64_to_zxy(qk_int)

print(f"인덱스에서 복원한 정보:")
print(f"  quadkey_int64 = {qk_int}")
print(f"  z={z_decoded}, tile_x={tile_x}, tile_y={tile_y}")
print(f"  offset={sample_entry['offset']}, length={sample_entry['length']}")
print()

# 여기까지는 격자 메타데이터 없이도 가능하다.
# Range Request로 데이터를 가져오는 것도 offset/length만 있으면 된다.
print(f"  → Range Request: bytes={sample_entry['offset']}-{sample_entry['offset'] + sample_entry['length'] - 1}")
print(f"  → 데이터 접근에는 메타데이터가 필요 없다!")
print()

# 하지만 "이 타일이 지도상 어디인가"를 알려면 격자 메타데이터가 필요하다.
print(f"실제 좌표로 변환하려면 격자 메타데이터가 필요:")
print(f"  origin = ({origin_x}, {origin_y})")
print(f"  extent = {extent}")
print(f"  zoom   = {ZOOM}")
print(f"  tile_size = {tile_size}")
print()

cx, cy = decode_quadkey(qk_int, ZOOM, origin_x, origin_y, extent)
print(f"  tile({z_decoded}/{tile_x}/{tile_y}) → 좌표 ({cx:.0f}, {cy:.0f})")
print()

# 격자 메타데이터를 JSON으로 저장하는 예시
import json
grid_meta = {
    "origin_x": origin_x,
    "origin_y": origin_y,
    "extent": extent,
    "zoom": ZOOM,
    "tile_size": tile_size,
}
meta_path = os.path.join(os.path.dirname(__file__), "output_grid_meta.json")
with open(meta_path, "w") as f:
    json.dump(grid_meta, f, indent=2)
print(f"격자 메타데이터 저장: {meta_path}")
print(json.dumps(grid_meta, indent=2))
print()
print("→ 인덱스(index.gz)와 메타데이터(grid_meta.json)를 함께 배포해야")
print("  클라이언트가 타일의 실제 좌표를 알 수 있다.")

# cleanup
os.remove(output_path)
os.remove(meta_path)
print("\n임시 파일 삭제 완료")
