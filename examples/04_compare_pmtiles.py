"""
예제 4: PMTiles vs QBTiles 인덱스 크기 비교

동일한 타일 엔트리를 PMTiles 방식과 QBTiles 방식으로 각각 직렬화하여
인덱스 크기를 비교한다.

결과 해석:
- 소규모(수만 개 이하) 데이터에서는 PMTiles가 더 작을 수 있다.
  비트마스크의 내부 노드 오버헤드가 tile_id delta보다 클 수 있기 때문.
- 대규모(수십만~수백만 개) 밀집 데이터에서 QBTiles가 유리해진다.
- QBTiles의 주된 이점은 압축률보다 인덱스 분리/재사용에 있다.
"""

import sys
import os
import random

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src", "python"))

import qbtiles as qbt


# ============================================================
# PMTiles 힐베르트 곡선 인코딩 (비교용)
# ============================================================

def zxy_to_tileid(z, x, y):
    """z/x/y를 PMTiles 힐베르트 타일 ID로 변환"""
    if z > 31:
        raise OverflowError("tile zoom exceeds 64-bit limit")
    acc = ((1 << (z * 2)) - 1) // 3
    a = z - 1
    while a >= 0:
        s = 1 << a
        rx = s & x
        ry = s & y
        acc += ((3 * rx) ^ ry) << a
        x, y = qbt.rotate(s, x, y, rx, ry)
        a -= 1
    return acc


# ============================================================
# 타일 생성 및 비교
# ============================================================

def generate_dense_region(zoom, x_range, y_range, fill_ratio=0.7):
    """특정 줌레벨에서 영역 내 타일을 밀집 생성"""
    tiles = set()
    x_min, x_max = x_range
    y_min, y_max = y_range
    for x in range(x_min, x_max):
        for y in range(y_min, y_max):
            if random.random() < fill_ratio:
                tiles.add((zoom, x, y))
    return tiles


def compare(label, tiles):
    """동일한 타일셋을 PMTiles/QBTiles 양쪽으로 직렬화하여 크기 비교"""
    random.seed(42)

    # PMTiles 직렬화
    pm_entries = []
    offset = 0
    for z, x, y in sorted(tiles):
        tid = zxy_to_tileid(z, x, y)
        length = random.randint(100, 5000)
        pm_entries.append(qbt.Entry(tid, offset, length, 1))
        offset += length
    pm_entries.sort(key=lambda e: e.tile_id)
    offset = 0
    for e in pm_entries:
        e.offset = offset
        offset += e.length
    pm_size = len(qbt.serialize_directory(pm_entries))

    # QBTiles 직렬화
    random.seed(42)
    qk_info = []
    offset = 0
    for z, x, y in sorted(tiles):
        qk = qbt.tile_to_quadkey_int64(z, x, y)
        length = random.randint(100, 5000)
        qk_info.append((qk, "", offset, length, 1))
        offset += length
    qk_info.sort(key=lambda x: x[0])
    offset = 0
    new_info = []
    for qk, p, _, length, rl in qk_info:
        new_info.append((qk, p, offset, length, rl))
        offset += length
    qk_info = new_info

    root = qbt.build_quadtree(qk_info)
    tmp = "_tmp_compare.gz"
    qbt.write_tree_bitmask_to_single_file(root, tmp)
    qb_size = os.path.getsize(tmp)
    os.remove(tmp)

    diff = pm_size - qb_size
    pct = (diff / pm_size * 100) if pm_size > 0 else 0

    print(f"  {label:<40} {len(tiles):>8,}개  PMTiles={pm_size:>8,}B  QBTiles={qb_size:>8,}B  {pct:>+5.1f}%")
    return pm_size, qb_size


random.seed(42)

print("=== 규모별 비교 (단일 줌레벨, 밀집 영역) ===")
print()

# 규모를 점점 키우면서 비교
compare("줌10, 50×50, 밀도 60%",
        generate_dense_region(10, (500, 550), (200, 250), 0.6))

compare("줌10, 100×100, 밀도 60%",
        generate_dense_region(10, (500, 600), (200, 300), 0.6))

compare("줌10, 200×200, 밀도 60%",
        generate_dense_region(10, (400, 600), (200, 400), 0.6))

compare("줌12, 500×500, 밀도 50%",
        generate_dense_region(12, (2000, 2500), (1000, 1500), 0.5))

compare("줌12, 1000×1000, 밀도 50%",
        generate_dense_region(12, (2000, 3000), (1000, 2000), 0.5))

compare("줌14, 1000×1000, 밀도 40%",
        generate_dense_region(14, (8000, 9000), (4000, 5000), 0.4))

print()
print("=== 다중 줌레벨 비교 ===")
print()

multi_tiles = set()
for z in range(6):
    n = 2 ** z
    for x in range(n):
        for y in range(n):
            multi_tiles.add((z, x, y))
multi_tiles.update(generate_dense_region(6, (48, 56), (20, 32), 0.8))
multi_tiles.update(generate_dense_region(7, (96, 112), (40, 64), 0.7))
multi_tiles.update(generate_dense_region(8, (192, 224), (80, 128), 0.6))

compare("줌0~8, 다중 줌레벨",
        multi_tiles)

print()
print("참고: +%는 QBTiles가 더 작음, -%는 PMTiles가 더 작음")
print("참고: QBTiles의 주된 이점은 인덱스 분리/재사용이며, 압축률은 데이터 규모에 따라 다르다")
