# PMTiles 및 SVO와의 비교

## PMTiles vs QBTiles

### PMTiles 인덱스 구조

```
[entry_count (varint)]
[tile_id_delta_0, tile_id_delta_1, ... (varint array)]
[run_length_0, run_length_1, ... (varint array)]
[length_0, length_1, ... (varint array)]
[offset_0, offset_1, ... (varint array, delta encoded)]
```

- 각 타일마다 **tile_id delta를 varint로 저장**해야 함
- 타일 분포가 희소할수록 → delta가 커지고 → 바이트 소비 증가
- 빈 타일은 간격을 숫자로 인코딩하여 "건너뜀"

### QBTiles 파일 구조 (v0.5.0)

```
[128B+ header: magic, version, flags, zoom, CRS, origin, extent,
               bitmask_length, values_offset, index_hash, field schema]
[bitmask section: 4-bit × 2 packed, BFS order (gzip-compressed)]
[values section: varints (variable mode) or fixed-size entries (fixed mode)]
```

- **tile_id 배열 없음** — quadkey는 bitmask로부터 복원
- 존재하지 않는 타일은 bit 0 — **비용 0**
- column-oriented 저장 → 같은 타입의 값을 모아 → 더 나은 압축률
- 3가지 모드: variable-entry (타일), fixed row (Range Request), fixed columnar (일괄 다운로드)

### 핵심 차이

PMTiles는 타일 ID를 delta로 **열거**한다.
QBTiles는 타일 존재 여부를 bitmask로 **구조적으로 인코딩**한다.

구조적 접근에서는 존재하지 않는 타일에 추가 비용이 들지 않는다. 타일이 전체 공간의 일부만 차지하는 일반적인 경우에 더 효율적이다.

---

## Sparse Voxel Octree (SVO) vs QBTiles

SVO는 **가장 직접적으로 유사한 기법**이다 — 3D에서의 동일한 아이디어.

### 유사점

| | SVO | QBTiles |
|---|---|---|
| 공간 분할 | Octree (8-way) | Quadtree (4-way) |
| 존재 인코딩 | 8-bit bitmask | 4-bit bitmask |
| 핵심 원리 | 존재하는 자식만 직렬화 → 순차 읽기로 디코딩 | 동일 |
| 빈 영역 비용 | 0 bits | 0 bits |
| 부분 접근 | VRAM 내 shader 순회 | HTTP Range Request |

두 방식 모두 **"bitmask로 존재 표현 → 존재하는 것만 직렬화 → 순차 읽기로 디코딩"** 을 사용한다.

### 차이점 1: 데이터 배치 — Row vs Column

**SVO는 row-oriented (mask와 data 인접 배치)**:
```
[mask][data] [mask][data] [mask][data] ...
```

**QBTiles는 column-oriented (같은 타입의 값을 모아 배치)**:
```
[mask][mask][mask]... [offset][offset][offset]... [length][length][length]...
```

이 차이는 **접근 패턴**에서 비롯된다:

| | SVO | QBTiles |
|---|---|---|
| 접근 패턴 | **부분 순회** (ray casting) | **전체 디코딩** 후 Map 조회 |
| 환경 | GPU shader, VRAM | 브라우저, 네트워크 |
| 병목 | GPU cache miss | 네트워크 전송 크기 |
| 최적화 목표 | 순회당 **메모리 접근 횟수** 최소화 | **파일 크기** 최소화 |

SVO shader는 프레임당 수백만 개의 ray를 쏘며, 각 ray는 서로 다른 트리 경로를 순회한다. 전체 디코딩은 비현실적이다. 따라서 mask를 data 옆에 배치하여 cache 친화적 순회를 구현한다.

QBTiles 인덱스는 작다 (KB ~ 수십 MB). 전체 다운로드 후 일괄 디코딩이 현실적이다. 따라서 column-oriented 배치로 delta + gzip 압축을 극대화한다.

### 차이점 2: 인덱스-데이터 관계

| | SVO | QBTiles |
|---|---|---|
| 관계 | **인덱스 = 데이터** | **인덱스 ≠ 데이터** |
| 설명 | 트리 자체가 VRAM 상주 데이터 | 인덱스가 offset/length 제공; 데이터는 Range Request로 조회 |

SVO는 voxel 데이터(색상, 밀도)를 트리 구조 안에 내장한다. 트리를 순회하는 것이 곧 데이터 접근이다.

QBTiles는 단일 `.qbt` 파일 내에서 인덱스(트리 구조 + 메타데이터)와 데이터(실제 타일 바이너리)를 **분리**한다. 인덱스 섹션이 각 타일의 위치를 알려주고, 실제 데이터는 같은 파일의 values 섹션에서 Range Request로 조회한다. index hash (SHA-256)를 통해 동일한 공간 구조를 공유하는 여러 파일 간 인덱스 재사용이 가능하다.

### 요약

SVO와 QBTiles는 동일한 핵심 아이디어(bitmask 기반 트리 직렬화)를 **서로 다른 도메인에 최적화**하여 적용한다:

- SVO → 3D 렌더링, VRAM 순회, row-oriented
- QBTiles → 지리 타일, 네트워크 전송, column-oriented
