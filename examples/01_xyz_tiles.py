"""
예제 1: 표준 XYZ 타일에서 QBTiles 인덱스 구축

일반적인 지도 타일(z/x/y 좌표)을 QBTiles 인덱스로 구축하고,
직렬화한 뒤 다시 역직렬화하여 검증하는 전체 과정.
"""

import sys
import os

# src/python을 모듈 경로에 추가
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src", "python"))

import qbtiles as qbt


# ============================================================
# 1단계: 타일 데이터 준비
# ============================================================
# 실제로는 타일 파일들이 존재하겠지만, 여기서는 가상의 타일 목록을 만든다.
# 각 타일은 데이터 파일 내의 offset과 length를 가진다.

# 예시: 줌레벨 3에서 한반도 부근의 타일들
tiles = [
    # (z, x, y, data_offset, data_length)
    (3, 6, 3, 0,     1024),
    (3, 6, 4, 1024,  2048),
    (3, 7, 3, 3072,  1536),
    (3, 7, 4, 4608,  1024),
    # 줌레벨 4에서 더 세밀한 타일들
    (4, 12, 6, 5632,  512),
    (4, 12, 7, 6144,  768),
    (4, 13, 6, 6912,  512),
    (4, 13, 7, 7424,  640),
    (4, 14, 6, 8064,  512),
    (4, 14, 7, 8576,  896),
    (4, 15, 6, 9472,  512),
    (4, 15, 7, 9984,  1024),
]

print(f"타일 {len(tiles)}개 준비 완료")
print()

# ============================================================
# 2단계: quadkey_info 구성
# ============================================================
# quadkey_info는 (quadkey_int64, path, offset, length, run_length) 튜플의 리스트.
# run_length는 해당 타일의 vertex 수 등 부가 정보. 여기서는 1로 설정.

quadkey_info = []
for z, x, y, offset, length in tiles:
    qk = qbt.tile_to_quadkey_int64(z, x, y)
    quadkey_info.append((qk, "", offset, length, 1))

    # quadkey 변환 확인
    qk_str = qbt.tile_to_quadkey(z, x, y)
    print(f"  tile({z}/{x}/{y}) → quadkey_str=\"{qk_str}\" → quadkey_int64={qk}")

# quadkey_int64 기준으로 정렬 (중요!)
quadkey_info.sort(key=lambda x: x[0])
print()

# ============================================================
# 3단계: 쿼드트리 구축
# ============================================================
root = qbt.build_quadtree(quadkey_info)
print("쿼드트리 구축 완료")

# ============================================================
# 4단계: 인덱스 직렬화 (index.gz 생성)
# ============================================================
output_path = os.path.join(os.path.dirname(__file__), "output_xyz_index.gz")
qbt.write_tree_bitmask_to_single_file(root, output_path, verbose=True)
print()

# ============================================================
# 5단계: 역직렬화 및 검증
# ============================================================
entries = qbt.deserialize_quadtree_index(output_path)
index_dict = qbt.build_quadkey_index_dict(entries)

print(f"\n복원된 엔트리 {len(entries)}개:")
print(f"{'quadkey':>12}  {'z':>2} {'x':>4} {'y':>4}  {'offset':>8} {'length':>8}")
print("-" * 50)
for e in entries:
    print(f"{e['quadkey']:>12}  {e['z']:>2} {e['x']:>4} {e['y']:>4}  {e['offset']:>8} {e['length']:>8}")

# ============================================================
# 6단계: 원본과 비교 검증
# ============================================================
print("\n=== 검증 ===")
all_ok = True
for z, x, y, offset, length in tiles:
    qk = qbt.tile_to_quadkey_int64(z, x, y)
    if qk not in index_dict:
        print(f"  FAIL: tile({z}/{x}/{y}) not found in index")
        all_ok = False
        continue
    e = index_dict[qk]
    if e["offset"] != offset or e["length"] != length:
        print(f"  FAIL: tile({z}/{x}/{y}) offset/length mismatch")
        all_ok = False
    else:
        print(f"  OK: tile({z}/{x}/{y})")

if all_ok:
    print("\n모든 타일 검증 통과!")

# ============================================================
# 7단계: 클라이언트에서의 사용 패턴 (참고)
# ============================================================
print("\n=== 클라이언트 사용 예시 ===")
print("브라우저에서 특정 타일의 데이터를 가져오려면:")
target_z, target_x, target_y = 4, 13, 7
qk = qbt.tile_to_quadkey_int64(target_z, target_x, target_y)
if qk in index_dict:
    e = index_dict[qk]
    print(f"  tile({target_z}/{target_x}/{target_y})의 인덱스 조회:")
    print(f"  → offset={e['offset']}, length={e['length']}")
    print(f"  → HTTP Range Request: Range: bytes={e['offset']}-{e['offset'] + e['length'] - 1}")

# cleanup
os.remove(output_path)
print("\n임시 파일 삭제 완료")
