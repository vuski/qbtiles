# QBTiles 아키텍처

## 배경

PMTiles를 실무에서 사용하던 중, **동일한 공간 구조를 가진 타일셋 다수를 시계열로 다루어야 하는 상황**에서 출발했다.

PMTiles는 인덱스가 데이터 파일에 내장되어 있다. 같은 영역·같은 줌레벨의 타일셋이 시간대별로 여러 개 존재할 때, 공간 구조가 동일함에도 매번 별도의 인덱스를 읽어야 한다. 이 비효율을 해결하기 위해 **인덱스를 데이터와 분리하여, 하나의 인덱스를 여러 데이터 파일에 재사용**하는 구조를 설계했다.

인덱스를 분리하는 김에  자연스럽게 인코딩 방식도 새로 고안하게 되었고, 지도 타일의 본질적인 쿼드트리 구조를 그대로 활용하는 비트마스크 방식을 적용한 결과, PMTiles 대비 인덱스 크기도 줄어드는 부수적 이점을 얻게 되었다.

물론 PMTiles 의 경우, 각각의 파일에 인덱스가 존재하는 이유는 각 엔트리에 해당하는 실질적 데이터를 최대한 압축해서 사용하기 때문이기도 하다. 압축을 하기 때문에 공간적 구조(특정 타일의 유무)가 동일하더라도 시계열에 따라서 각 엔트리의 시작 위치와 길이가 달라질 수 있다. 

그래서 여기서 이름 붙인 QBTiles의 경우, 각 타일 데이터의 크기는 다소 증가할 수 있다. 물론 이것은 시계열에 따라서 동일하게 데이터 크기를 맞출 경우에 그러하고, 독립적인 하나의 파일로 만들 경우 PMTiles 처럼 데이터를 압축하는 것은 가능하다. 

QBTiles는 PMTiles와 완전히 교환가능한 수준의 완성된 타일 포맷은 아니다.  PMTiles 같은 경우 전세계 OSM처럼 파일이 100GB를 넘어갈 때 인덱스를 분산시켜서 단계적으로 접근하도록 했다. QBTiles의 경우 이러한 설계는 아직 적용시키지 못했다.



## QBTiles란

QBTiles (Quadkey Bitmask Tiles)는 클라우드 최적화 타일 아카이브 인덱스 포맷이다.

지도 타일은 본질적으로 쿼드트리 구조(줌레벨 = 트리 깊이)이다. QBTiles는 이 자연스러운 구조를 그대로 활용하여, **타일 존재 여부를 4비트 비트마스크로 표현**하고 **BFS 순회로 직렬화**한다.

## PMTiles와의 핵심 차이


|         | PMTiles                    | QBTiles                 |
| ------- | -------------------------- | ----------------------- |
| 공간 인덱싱  | 힐베르트 곡선 (1차원 펼침)           | 쿼드트리 비트마스크 (트리 구조 유지)   |
| 타일 식별   | tile_id delta 배열 저장        | **저장 안 함** — 비트마스크에서 복원 |
| 빈 타일 처리 | delta 값으로 갭 기록 (바이트 비용 발생) | 비트마스크에서 0 (0비트 비용)      |
| 인덱스 위치  | 데이터 파일에 내장                 | **독립 파일**               |
| 인덱스 크기  | 기준                         | 5% ~40% 작음              |




### 왜 인덱스가 작아지는가

PMTiles는 존재하는 타일 간의 **ID 갭(delta)을 숫자로 기록**한다. 타일이 듬성듬성 분포하면 delta가 커지고 varint 바이트도 늘어난다.

QBTiles는 부모 노드의 **4비트 비트마스크**로 자식 4개의 존재 여부를 한꺼번에 표현한다. 존재하지 않는 자식은 비트가 0일 뿐, 추가 바이트 비용이 없다. 이 비트마스크를 BFS 순서로 이어 붙이면 모든 quadkey를 복원할 수 있으므로, 타일 ID를 개별 저장할 필요가 없다.

### 인덱스 분리의 이점

QBTiles 인덱스는 데이터 파일과 분리되어 있다. 동일한 타일 구조(같은 영역, 같은 줌레벨)를 공유하는 여러 데이터 파일에 **하나의 인덱스를 재사용**할 수 있다.



## 관련 기존 기법

QBTiles의 개별 기법은 모두 기존에 존재한다. QBTiles의 가치는 이를 지리 타일 인덱싱에 실용적으로 조합한 것이다.

### Sparse Voxel Octree (SVO)

QBTiles와 가장 직접적으로 같은 아이디어의 3D 버전. 상세 비교는 [comparison.md](comparison.md) 참조.

### LOUDS (Level-Order Unary Degree Sequence)

트리 토폴로지를 BFS 순서로 최소 비트로 인코딩하는 간결 자료구조(succinct data structure). QBTiles의 비트마스크 BFS 직렬화와 유사한 학술적 배경.

### Hierarchical Bitmap

데이터베이스에서 다단계 비트맵 인덱스로 사용. 상위 비트맵에서 1인 영역만 하위 비트맵이 존재하는 계층 구조.

### JBIG2 / JPEG 2000

이미지 코딩에서 쿼드트리 분할로 영역의 데이터 존재 여부를 재귀적으로 인코딩.

## 컴포넌트

### Python 빌더 (`src/python/qbtiles.py`)

인덱스 구축 및 직렬화/역직렬화:

- 쿼드트리 구축: `build_quadtree()`
- 인덱스 직렬화: `write_tree_bitmask_to_single_file()`
- 인덱스 역직렬화: `deserialize_quadtree_index()`
- 쿼드키 변환: `tile_to_quadkey_int64()`, `quadkey_int64_to_zxy()` 등
- PMTiles 비교: `serialize_directory()` (크기 비교용)

### TypeScript 리더 (`src/typescript/qbtiles.ts`)

브라우저에서 인덱스를 역직렬화:

- `deserializeQuadtreeIndex()` → `Map<bigint, QBTilesIndex>`
- `quadkeyInt64ToZXY()`, `tileToQuadkeyInt64()` 좌표 변환

### C++ 인코더 (`src/cpp/`)

PMTiles 힐베르트 타일 ID를 QBTiles quadkey int64로 배치 변환. pybind11을 통해 Python numpy 배열과 연동.

빌드된 `.pyd` 파일(`tileid_encoder.cp312-win_amd64.pyd`)이 `examples/`에 포함되어 있으므로, Python 3.12 + Windows 환경이면 CMake 빌드 없이 `import tileid_encoder`로 바로 사용 가능. 다른 환경에서는 `src/cpp/`에서 pybind11로 직접 빌드해야 한다.

## 데이터 흐름

### 빌드 타임

```
타일 데이터 파일들
  → quadkey 기준 정렬
  → 하나의 데이터 파일로 합치기 (연속 저장)
  → 쿼드트리 빌드 (quadkey_info → QuadTreeNode 트리)
  → BFS 비트마스크 직렬화 + 열 방향 varint + gzip 압축
  → index.gz
```

### 런타임 (클라이언트)

```
fetch index.gz
  → gzip 압축 해제
  → 비트마스크에서 quadkey 복원 + varint에서 offset/length 복원
  → Map<quadkey_int64, {offset, length, ...}>
  → 뷰포트의 타일 좌표 → quadkey_int64로 변환 → Map에서 lookup
  → HTTP Range Request로 데이터 파일에서 해당 타일 로딩
```

