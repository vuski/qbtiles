# QBTiles v1.0 바이너리 포맷 명세

## 개요

QBTiles v1.0은 공간 인덱싱 데이터를 위한 통합 바이너리 포맷이다. 두 가지 모드를 지원한다:

- **Variable-entry 모드** (`entry_size = 0`): 각 엔트리의 크기가 다르다. offset/length 배열을 포함한다. 타일 데이터가 동일한 `.qbt` 파일에 내장된다. 타일 아카이브(MVT, PNG 등)용 — PMTiles 대체.
- **Fixed-entry 모드** (`entry_size > 0`): 모든 엔트리의 바이트 크기가 동일하다. offset/length 배열이 불필요하다. 래스터 그리드, 고정 크기 레코드용 — 희소 데이터에서 GeoTIFF 대체.

두 모드 모두 동일한 헤더, bitmask 구조, 공간 인덱싱을 공유한다. 단일 파서로 양쪽 모두 처리 가능하다. 모든 데이터는 **단일 `.qbt` (또는 `.qbt.gz`) 파일**에 포함되며 — 인덱스와 데이터는 절대 분리되지 않는다.

## 파일 구조

```
[Header]              고정 크기, ≥128 바이트
[Bitmask Section]     4비트 자식 마스크, BFS 순서
[Varint Section]      Variable 모드 전용: run_lengths[], lengths[], offsets[]
[Values Section]      Fixed 모드 전용: entry_size × leaf_count 바이트
[Metadata Section]    선택적 JSON
```

## 1. 헤더

모든 다중 바이트 정수는 별도 표기가 없는 한 **리틀 엔디안**이다.

```
Offset  Size  Type      Field              Description
──────  ────  ────────  ─────────────────  ─────────────────────────────────────
0       4     char[4]   magic              "QBT\x01" (0x51 0x42 0x54 0x01)
4       2     uint16    version            1 (현재)
6       2     uint16    header_size        전체 헤더 바이트 수 (≥128). bitmask는 이 오프셋부터 시작.
8       4     uint32    flags              Bit 0: 0=variable, 1=fixed entry 모드
                                           Bit 1: 0=row 레이아웃, 1=columnar 레이아웃
                                           Bit 2: 0=bitmask gzip 압축, 1=bitmask raw
                                           Bits 3–31: 예약 (반드시 0)
                                           참고: flags=0x2 (variable + columnar)는 예약됨.
12      1     uint8     zoom               quadtree 깊이 (리프 줌 레벨)
13      1     uint8     reserved           반드시 0
14      2     uint16    crs                EPSG 코드. 0 = 사용자 정의 CRS (origin/extent 사용).
                                           4326 = WGS84 위경도.
16      8     float64   origin_x           그리드 원점의 X 좌표 (왼쪽 경계)
24      8     float64   origin_y           그리드 원점의 Y 좌표 (위쪽 경계)
32      8     float64   extent_x           X 방향 그리드 범위
40      8     float64   extent_y           Y 방향 그리드 범위 (아래 방향 양수)
48      8     uint64    bitmask_length     bitmask 섹션의 바이트 길이
56      8     uint64    values_offset      values 섹션의 바이트 오프셋 (fixed 모드)
64      8     uint64    values_length      values 섹션의 바이트 길이
72      8     uint64    metadata_offset    JSON 메타데이터의 바이트 오프셋 (0 = 없음)
80      8     uint64    metadata_length    JSON 메타데이터의 바이트 길이
88      4     uint32    entry_size         엔트리당 바이트 수. 0 = variable 모드.
92      2     uint16    field_count        스키마의 필드 수 (fixed 모드)
94      32    bytes     index_hash         bitmask 섹션의 SHA-256 (header_size ~ values_offset).
                                           미계산 시 전부 0.
126     2     bytes     reserved           반드시 0. 향후 사용 예약.
──────  ────
128            최소 헤더 크기
```

### 필드 스키마 (fixed 모드 전용)

128 바이트 직후부터 `field_count`개의 필드 디스크립터가 이어진다:

```
Offset  Size  Type      Field              Description
──────  ────  ────────  ─────────────────  ─────────────────────────────────────
0       1     uint8     type               타입 코드 (아래 참조)
1       1     uint8     offset             엔트리 내 바이트 오프셋
2       2     uint16    name_length        필드명의 바이트 길이
4       var   char[]    name               UTF-8 필드명 (null 종단 없음)
```

필드 디스크립터는 패딩 없이 순차적으로 연결된다.

**타입 코드:**

| Code | Type    | Size   |
|------|---------|--------|
| 1    | uint8   | 1      |
| 2    | int16   | 2      |
| 3    | uint16  | 2      |
| 4    | int32   | 4      |
| 5    | uint32  | 4      |
| 6    | float32 | 4      |
| 7    | float64 | 8      |
| 8    | int64   | 8      |
| 9    | uint64  | 8      |
| 10   | varint  | variable | 부호 없는 LEB128. columnar 모드 전용. |

**Row 레이아웃** (flags bit 1 = 0): `entry_size`는 모든 필드 크기의 합과 같아야 한다. 고정 크기 타입(1–9)만 허용된다. 파서는 이를 검증해야 한다.

**Columnar 레이아웃** (flags bit 1 = 1): `entry_size`는 0이다. 가변 길이 타입(varint)이 허용된다. 각 디스크립터의 `offset` 필드는 무시된다 (컬럼이 순차 저장됨).

### 헤더 확장성

`header_size`는 128 + 필드 스키마 바이트를 초과할 수 있다. 파서는 bitmask 섹션을 찾기 위해 반드시 `header_size`까지 건너뛰어야 한다. 필드 스키마와 `header_size` 사이의 알 수 없는 바이트는 무시되며, 이를 통해 하위 호환성을 보장한다.

## 2. magic 바이트

```
Bytes 0–3 = "QBT\x01" (0x51 0x42 0x54 0x01)
```

파서는 처리 전에 반드시 magic 바이트를 검증해야 한다.

## 3. Bitmask 섹션

바이트 오프셋 `header_size`에서 시작한다. quadtree를 **BFS (너비 우선) 순서**로 인코딩한다.

### Bitmask 인코딩

각 노드는 4비트 자식 존재 마스크를 가진다:

```
Bit position:  [3] [2] [1] [0]
Child number:   0   1   2   3
Quadkey digit:  0   1   2   3
```

- 비트 설정 → 자식 존재 (하위 탐색 또는 리프)
- 비트 해제 → 자식 없음 (해당 사분면에 데이터 없음)

### Quadkey 자릿수 매핑

```
digit 0 = top-left      (row bit 0, col bit 0)
digit 1 = top-right     (row bit 0, col bit 1)
digit 2 = bottom-left   (row bit 1, col bit 0)
digit 3 = bottom-right  (row bit 1, col bit 1)
```

### 바이트 패킹

한 바이트에 4비트 bitmask 2개, 상위 니블 우선:

```
byte = (first_bitmask << 4) | second_bitmask
```

전체 노드 수가 홀수이면 마지막 바이트의 하위 니블은 0이다. 역직렬화 시 후행 0 니블은 제거된다.

### BFS 순회

```
Level 0 (root):   [root bitmask]
Level 1:          [child0 bitmask] [child1 bitmask] ...
Level 2:          [grandchild bitmasks...]
...
Level zoom-1:     [parent-of-leaf bitmasks]
```

줌 깊이(리프 레벨)에 도달하면 순회가 종료된다. 리프 노드는 bitmask 항목이 없다 — 데이터 엔트리 자체이다. 각 리프는 사실상 부모 bitmask의 **단일 비트**로 표현된다: 1 = 존재, 0 = 비어 있음.

### Quadkey 복원

타일 ID는 저장되지 않는다. BFS 트리를 확장하여 quadkey를 복원한다:

```
root = 0b11 (prefix)
for each node's bitmask:
    for each set bit i (0..3):
        child_quadkey = (parent_quadkey << 2) | i
```

BFS 순서에서 만나는 리프 수가 리프 인덱스(0 기반)를 결정하며, 이는 values 섹션에 직접 매핑된다.

## 4. Values 섹션 (Fixed-Entry 모드)

### 4a. Row 레이아웃 (flags bit 1 = 0)

`entry_size > 0`일 때, values 섹션은 오프셋 `values_offset`에 `leaf_count × entry_size` 바이트를 포함한다.

리프 `i`는 바이트 `[values_offset + i × entry_size, values_offset + (i+1) × entry_size)` 를 차지한다.

**이것이 셀 단위 Range Request를 가능케 하는 핵심 속성이다**: bitmask만 별도로 다운로드하면, 클라이언트는 임의의 공간 쿼리에 대해 `leaf_index`를 계산한 뒤 정확히 `entry_size` 바이트만 요청할 수 있다:

```
Range: bytes={values_offset + leaf_index * entry_size}-{values_offset + (leaf_index + 1) * entry_size - 1}
```

values 섹션은 **비압축**이며, 직접적인 Range Request 접근이 가능하다.

**다중 필드 예시** (row 레이아웃):

```
entry_size: 6
fields: [
    { type: uint16, offset: 0, name: "total" },
    { type: uint16, offset: 2, name: "male" },
    { type: uint16, offset: 4, name: "female" },
]

Values: [total₀|male₀|female₀][total₁|male₁|female₁]...
```

각 리프의 6바이트에 세 값이 연속으로 포함된다.

### 4b. Columnar 레이아웃 (flags bit 1 = 1)

값은 필드 스키마 순서대로 컬럼 단위로 저장된다. `entry_size`는 0이다 (해당 없음).

```
[column 0: leaf_count values] [column 1: leaf_count values] ...
```

- **고정 크기 타입** (uint8–uint64, float32/64): `leaf_count × type_size` 바이트, 리틀 엔디안.
- **varint** (type 10): `leaf_count`개의 부호 없는 LEB128 값이 순차적으로 패킹된다.

**예시** (columnar 레이아웃, varint):

```
entry_size: 0
fields: [
    { type: varint, offset: 0, name: "total" },
    { type: varint, offset: 0, name: "male" },
    { type: varint, offset: 0, name: "female" },
]

Values: [total₀ total₁ total₂ ...][male₀ male₁ ...][female₀ female₁ ...]
         (varint, variable bytes)   (varint)          (varint)
```

Columnar 레이아웃은 압축(gzip)을 동반한 일괄 다운로드에 최적화되어 있다. 동일 타입의 값이 모여 있어 row 레이아웃보다 더 높은 압축률을 달성한다. Columnar 모드에서는 셀 단위 Range Request가 **지원되지 않는다**.

## 5. Varint 섹션 (Variable-Entry 모드)

`entry_size = 0`일 때, varint 섹션은 bitmask 섹션 뒤에 위치한다. 세 개의 varint 배열이 컬럼 방식으로 저장된다:

```
[run_lengths array] [lengths array] [offsets array]
```

각 배열은 `node_count`개의 요소를 가진다 (= 내부 노드를 포함한 BFS 순회 노드 수).

### run_lengths[]

각 노드의 run_length 값. varint 인코딩.

### lengths[]

각 노드의 데이터 바이트 길이. varint 인코딩. `length == 0`인 노드는 내부 전용(해당 레벨에 타일 데이터 없음).

**다중 줌 레벨 타일 지원:** 타일은 임의의 줌 레벨 조합에 존재할 수 있다. `length > 0`인 노드는 자식의 존재 여부와 관계없이 타일 데이터를 가진다. 이를 통해 특정 줌 레벨만 채워진 경우, 전체 줌 레벨에 타일이 있는 경우, 중간 레벨이 빠진 경우를 모두 올바르게 처리할 수 있다 — 별도의 특수 인코딩이 필요 없다.

### offsets[] (delta encoding)

각 노드의 `.qbt` 파일 values 섹션 내 바이트 오프셋:

- 연속 엔트리 (`offset[i] == offset[i-1] + length[i-1]`): `0` 기록
- 비연속: `offset[i] + 1` 기록

### 타일 데이터 접근

동일 `.qbt` 파일에 대해 `values_offset + offset`과 `length`를 사용하여 HTTP Range Request로 접근한다:

```
Range: bytes={values_offset + offset}-{values_offset + offset + length - 1}
```

## 6. 메타데이터 섹션

`metadata_offset`에 위치하는 선택적 JSON. 부가 정보를 포함한다:

```json
{
    "description": "WorldPop 2025 global population density, 1km",
    "source": "https://www.worldpop.org/",
    "nodata": -99999,
    "units": "persons per km²",
    "year": 2025
}
```

`metadata_offset = 0`이면 메타데이터가 없다.

## 7. 좌표계

### 표준 CRS (crs > 0)

`crs`가 유효한 EPSG 코드(예: 4326)일 때, `origin_x/y`와 `extent_x/y`는 해당 CRS의 기본 단위를 따른다.

EPSG:4326의 경우:
- `origin_x` = 최서단 경도
- `origin_y` = 최북단 위도
- `extent_x` = 전체 경도 범위
- `extent_y` = 전체 위도 범위

셀 중심 좌표:

```
cell_size_x = extent_x / 2^zoom
cell_size_y = extent_y / 2^zoom
x = origin_x + col * cell_size_x + cell_size_x / 2
y = origin_y - row * cell_size_y - cell_size_y / 2
```

### 사용자 정의 CRS (crs = 0)

origin과 extent가 임의의 평면 좌표계를 정의한다. 투영 변환은 외부에서 처리해야 한다 (예: 메타데이터 JSON에 저장된 파라미터로 proj4 사용).

## 8. 공간 쿼리 알고리즘

### 셀 단위 접근 (fixed 모드)

```
1. 헤더(128B)를 가져온 뒤, Range Request로 bitmask 섹션 요청
2. BFS로 bitmask를 확장하여 대상 셀의 leaf_index를 구함
3. byte_offset = values_offset + leaf_index × entry_size
4. 동일 .qbt 파일에 entry_size 바이트만큼 HTTP Range Request
```

### 바운딩 박스 쿼리 (fixed 모드)

```
1. .qbt 파일에서 헤더 + bitmask를 가져옴
2. bbox를 리프 줌의 row/col 범위로 변환
3. BFS로 bitmask를 순회하며 bbox와 겹치는 사분면만 하위 탐색
4. 일치하는 셀의 리프 인덱스를 수집
5. 인접한 인덱스를 연속 바이트 범위로 병합
6. 동일 .qbt 파일에서 병합된 범위를 Range Request로 요청
```

Z-order (quadkey) 정렬은 공간적으로 가까운 셀이 가까운 리프 인덱스를 가지도록 보장하여, 밀집된 공간 쿼리에서 적은 수의 병합 범위를 생성한다.

### 타일 접근 (variable 모드)

```
1. .qbt 파일에서 헤더(128B), 이후 bitmask + varint 섹션을 가져옴
2. bitmask + varint 배열을 압축 해제 및 역직렬화
3. quadkey로 타일을 조회 → offset + length (values_offset 기준 상대값)
4. 동일 .qbt 파일에 타일 데이터를 Range Request
```

## 9. 파일 확장자

| Extension        | Description                                      |
|------------------|--------------------------------------------------|
| `.qbt`           | QBTiles 파일 (헤더 + bitmask + values/varints)     |
| `.qbt.gz`        | gzip 압축된 QBTiles (columnar 모드에서 주로 사용)   |

## 10. Columnar vs Row 저장 방식

Variable 모드는 행 지향(노드별 트리플릿)이 아닌 **컬럼 방식** 레이아웃(run_lengths 전체, lengths 전체, offsets 전체 순)을 사용한다. 이는 더 작은 gzip 출력을 생성하는데, 그 이유는:

- 동일 타입의 값이 모여 있어 → 더 작은 델타 → 더 적은 varint 바이트
- gzip이 동질적 데이터에서 더 많은 반복 바이트 패턴을 발견

## 11. 요약

```
                    Variable mode           Fixed row               Fixed columnar
                    (flags=0x0)             (flags=0x1)             (flags=0x3)
─────────────────   ──────────────────────  ──────────────────────  ──────────────────────
Use case            타일 아카이브           래스터 그리드 (Range)    압축 그리드
ID storage          Zero (bitmask)          Zero (bitmask)          Zero (bitmask)
Per-entry metadata  offset+length (varint)  None (index-computed)   None
Value types         N/A                     고정 크기만 (1–9)       고정 + varint (1–10)
Access              타일 단위              셀 단위 (Range Req)      전체 파일 (gzip)
Compression         Index: gzip; Data: any  Index: gzip; Values: ×  전체 파일: gzip
Replaces            PMTiles                 COG (sparse)            Parquet (sparse)
```
