# 아키텍처

## 배경

PMTiles를 **동일한 공간 구조를 공유하는 시계열 타일 데이터**와 함께 사용할 때, 타일 레이아웃이 타임스탬프 간에 동일하더라도 각 파일마다 자체 인덱스를 내장해야 한다.

PMTiles는 인덱스를 데이터 파일 내부에 내장한다. 같은 영역과 줌 레벨에 대한 타일셋이 여러 시점에 걸쳐 존재할 때, 공간 구조는 동일하지만 각 파일을 개별적으로 인덱싱해야 한다.

이 문제를 해결하기 위한 대안적 타일 인덱스를 설계하는 과정에서, 세 가지 핵심 속성을 가진 포맷이 만들어졌다:

1. **bitmask 인코딩으로 좌표 저장을 제거한다.** 셀 존재 여부를 BFS 순서의 4-bit 마스크로 인코딩하여, 위치를 명시적으로 저장하지 않고 트리 구조로부터 암시한다. 이것만으로 PMTiles의 델타 인코딩된 타일 ID 대비 인덱스 크기가 20~30% 감소한다.

2. **bitmask와 함께 배치된 고정 크기 값 블록이 셀 단위 Range Request를 가능하게 한다.** 값을 알려진 오프셋(`leaf_index × entry_size`)에 배치함으로써, QBTiles는 COG에 비견되는 래스터 데이터 컨테이너로 기능할 수 있다 — 다만 512×512 블록이 아닌 셀 단위 정밀도를 제공한다. columnar 레이아웃 변형은 대량 다운로드 시 압축률을 더욱 개선한다.

3. **인덱스 해시(SHA-256)가 시계열 파일 간 재사용을 가능하게 한다.** 각 헤더는 bitmask 섹션의 해시를 저장한다. 동일한 공간 구조를 공유하는 여러 파일은 같은 해시를 가지므로, 클라이언트는 bitmask를 한 번만 다운로드하고 이후 파일은 128바이트 헤더 비교만으로 검증하여 인덱스를 완전히 건너뛸 수 있다.

## QBTiles란

QBTiles (Quadkey Bitmask Tiles)는 존재를 트리 구조로 인코딩하여 ID 저장 비용을 0으로 만드는 공간 데이터 포맷이다.

지도 타일과 공간 그리드는 본질적으로 quadtree이다 (줌 레벨 = 트리 깊이). QBTiles는 이 자연적 구조를 활용하여, **셀 존재 여부를 4-bit bitmask로 인코딩**하고 **BFS 순회**로 직렬화한다.

![quadkey bitmask structure](quadkey_bitmask.png)

## 세 가지 모드

| 모드 | Flags | 용도 | 비교 대상 |
|------|-------|------|-----------|
| **Variable-entry** | `0x0` | 타일 아카이브 (MVT, PNG) | PMTiles |
| **Fixed row** | `0x1` | 래스터 그리드 (Range Request) | COG (GeoTIFF) |
| **Fixed columnar** | `0x3` | 압축 그리드 (대량 다운로드) | Parquet |

## PMTiles와의 주요 차이

| | PMTiles | QBTiles |
|---|---|---|
| 공간 인덱싱 | 힐베르트 곡선 (1D 매핑) | quadtree bitmask (트리 구조) |
| 타일 식별 | tile_id 델타 배열 | **저장하지 않음** — bitmask에서 복원 |
| 빈 타일 | 델타로 갭 인코딩 (바이트 소비) | 비트가 0 (비용 없음) |
| 인덱스 위치 | 데이터 파일에 내장 | 내장, 인덱스 해시로 재사용 가능 |
| 인덱스 크기 | 기준선 | 20~30% 더 작음 |
| 데이터 모드 | 타일 아카이브만 | 타일 아카이브 + 래스터 그리드 + columnar |

### 인덱스가 더 작은 이유

PMTiles는 존재하는 타일 간의 **ID 갭(델타)**을 숫자로 기록한다. 타일 분포가 희소할수록 델타가 커지고 varint 바이트가 더 많이 필요하다.

QBTiles는 부모 노드당 **4-bit bitmask**를 사용하여 네 자식의 존재 여부를 한 번에 표현한다. 존재하지 않는 자식은 단순히 0 비트이며 추가 비용이 없다. bitmask를 BFS 순서로 연결함으로써, 타일 ID를 개별 저장하지 않고도 모든 quadkey를 복원할 수 있다.

### 해시를 통한 인덱스 재사용

QBT 헤더에는 bitmask 섹션의 SHA-256 해시가 포함된다. 동일한 공간 구조를 가진 시계열 파일들은 같은 해시를 공유하므로, 클라이언트는 bitmask를 한 번만 다운로드하고 이후 파일에 재사용한다.

## 관련 연구

QBTiles의 개별 기법은 모두 기존에 존재한다. QBTiles의 가치는 이들을 지리 데이터에 실용적으로 결합한 데 있다.

### Sparse Voxel Octree (SVO)

가장 직접적으로 유사한 기법 — 3D에서의 동일한 아이디어. 자세한 내용은 [비교](comparison.md) 참조.

### LOUDS (Level-Order Unary Degree Sequence)

최소 비트로 BFS 순서의 트리 토폴로지를 인코딩하는 간결 자료구조. QBTiles의 bitmask BFS 직렬화와 유사한 학술적 기반.

### 계층적 비트맵

데이터베이스에서 다계층 비트맵 인덱스로 사용된다. 부모 비트가 1인 곳에만 자식 비트맵이 존재하는 계층 구조.

## 구성 요소

### Python 작성기 (`src/python/qbtiles.py`)

QBT 파일 생성 및 직렬화:

- **`build()`** — 통합 빌더: 인자로 모드 자동 판단 (`folder` → variable, `columns` → columnar, `values` → fixed), `cell_size`로 zoom 자동 계산, 좌표에서 origin/extent 자동 계산
- **`build(geotiff=)`** — GeoTIFF를 QBTiles로 직접 변환 (cell_size, CRS, origin, extent, nodata 자동 감지)
- quadtree 구성: `build_quadtree()`
- bitmask 직렬화: `serialize_bitmask()`
- 파일 작성기: `write_qbt_variable()`, `write_qbt_fixed()`, `write_qbt_columnar()`
- 헤더 파싱: `read_qbt_header()`
- quadkey 변환: `tile_to_quadkey_int64()`, `quadkey_int64_to_zxy()` 등

### TypeScript 리더 (`src/typescript/`)

브라우저 측 QBT 읽기 및 공간 쿼리:

- **`openQBT(url)`** → `QBT` 클래스 — 통합 로더, 헤더 flags에서 모드 자동 감지
- `QBT.getTile(z, x, y)` — 타일 데이터 가져오기 (variable 모드)
- `QBT.query(bbox)` — 공간 쿼리 (전체 모드)
- `QBT.columns` — 컬럼 값 (columnar 모드)
- `QBT.addProtocol(maplibregl)` — MapLibre 커스텀 프로토콜 (variable 모드)
- `QBT.toWGS84(x, y)` / `QBT.fromWGS84(lng, lat)` — proj4를 통한 CRS 변환
- `registerCRS(epsg, proj4Def)` — 커스텀 CRS 정의 등록
- 저수준: `parseQBTHeader()`, `queryBbox()`, `mergeRanges()`, `fetchRanges()`, `readColumnarValues()`

### C++ 인코더 (`src/cpp/`)

PMTiles 힐베르트 타일 ID를 QBTiles quadkey int64로 일괄 변환. pybind11을 통해 Python numpy 배열과 연동.

## 데이터 흐름

### Variable-entry (타일 아카이브)

```
Build time:
  qbt.build("output.qbt", folder="tiles/")
    → Sort by quadkey
    → Build quadtree → serialize_bitmask() + varint arrays
    → write_qbt_variable() → single .qbt file
      [header][gzip(bitmask + varints)][tile_data...]

Runtime:
  openQBT(url)
    → fetch header (128B) → check index hash cache
    → fetch bitmask section → gzip decompress → build index
    → getTile(z, x, y) → Range Request for tile data
    → addProtocol(maplibregl) → MapLibre custom protocol
```

### Fixed-entry (래스터 그리드)

```
Build time:
  qbt.build("output.qbt", coords=..., values=..., cell_size=1000)
    → Auto-calculate zoom/origin/extent, snap coords to grid
    → Build quadtree → serialize_bitmask()
    → write_qbt_fixed() → single .qbt file
      [header][gzip(bitmask)][raw values]

  qbt.build("output.qbt.gz", coords=..., columns=..., cell_size=100, crs=5179)
    → write_qbt_columnar() → single .qbt.gz file
      gzip([header][gzip(bitmask)][col1][col2]...)

Runtime (fixed row):
  openQBT(url)
    → fetch header → fetch bitmask via Range Request → build index
    → query(bbox) → leaf indices → Range Request per cell

Runtime (columnar):
  openQBT(url)
    → fetch entire .qbt.gz → decompress → parse header + bitmask + columns
    → columns → Map<fieldName, number[]>
    → query(bbox) → in-memory lookup
```
