# QBTiles

**QBTiles** (Quadkey Bitmask Tiles)는 클라우드 최적화 타일 아카이브 인덱스 포맷이다.

타일 존재 여부를 **4비트 비트마스크**로 BFS 순서로 인코딩한다. 타일 ID를 저장하지 않고 트리 구조에서 quadkey를 복원하므로, PMTiles보다 작은 인덱스를 생성한다.

## 왜 QBTiles인가?

PMTiles를 사용하던 중, 동일한 공간 구조를 가진 시계열 타일셋에서 매번 별도의 인덱스를 읽어야 하는 비효율을 발견했다. QBTiles는 **인덱스를 데이터와 분리**하여, 하나의 인덱스를 여러 데이터 파일에 재사용할 수 있도록 설계되었다.

## 주요 특징

- **작은 인덱스**: 데이터 밀도에 따라 PMTiles 대비 5~48% 절감
- **인덱스 분리**: 동일 타일 구조의 여러 데이터 파일에 인덱스 재사용
- **단순한 인코딩**: 쿼드트리 비트마스크 BFS — 힐베르트 곡선 계산 불필요
- **클라우드 네이티브**: HTTP Range Request로 서버리스 타일 서빙 (S3, R2 등)

## 빠른 시작

### 인덱스 구축 (Python)

```python
import qbtiles as qbt

# 1. 타일 정의 — 각 타일의 위치(z/x/y)와 데이터 파일 내 위치
tiles = [
    # (z,  x,  y,  offset, length)
    (3,   6,  3,       0,   1024),
    (3,   6,  4,    1024,   2048),
    (3,   7,  3,    3072,   1536),
    (3,   7,  4,    4608,   1024),
]

# 2. z/x/y를 quadkey로 변환 → 정렬 → 트리 구축 → 직렬화
quadkey_info = []
for z, x, y, offset, length in tiles:
    qk = qbt.tile_to_quadkey_int64(z, x, y)
    quadkey_info.append((qk, "", offset, length, 1))

quadkey_info.sort(key=lambda x: x[0])
root = qbt.build_quadtree(quadkey_info)
qbt.write_tree_bitmask_to_single_file(root, "index.gz")
```

### 인덱스 읽기 & 타일 조회 (Python)

```python
# 3. 인덱스 역직렬화
entries = qbt.deserialize_quadtree_index("index.gz")
index_dict = qbt.build_quadkey_index_dict(entries)

# 4. z/x/y로 타일 조회
qk = qbt.tile_to_quadkey_int64(3, 7, 3)
entry = index_dict[qk]
print(entry["offset"], entry["length"])
# → offset/length로 HTTP Range Request
```

### 브라우저에서 인덱스 읽기 (TypeScript)

```typescript
import { deserializeQuadtreeIndex, tileToQuadkeyInt64 } from './qbtiles';

// index.gz를 fetch하고 gzip 해제한 후:
const entryMap = deserializeQuadtreeIndex(buffer);
const qk = tileToQuadkeyInt64(3, 7, 3);
const entry = entryMap.get(qk);
// → { offset: 3072, length: 1536 } → HTTP Range Request
```

## 프로젝트 구조

```
src/
  python/qbtiles.py        — 인덱스 빌더 및 직렬화
  typescript/qbtiles.ts    — 클라이언트 리더 (브라우저)
  cpp/                     — 네이티브 힐베르트→쿼드키 인코더 (pybind11)
examples/                  — 사용 예제 및 샘플 데이터
```

## 상태

QBTiles는 PMTiles를 완전히 대체하는 수준은 아니다:

- 100GB 이상 데이터셋에 대한 계층적 디렉토리 분할 미구현
- 인덱스 빌드 시간이 PMTiles 직렬화보다 약 2배 느림

## 라이선스

MIT
