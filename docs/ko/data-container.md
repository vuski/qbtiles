# 타일 인덱싱을 넘어서 — QBTiles를 데이터 컨테이너로

## 타일 컨테이너에서 GeoTIFF의 대체 용도로

본래 QBTiles는 데이터 공간의 규격이 일정한 시계열 데이터에서 인덱스를 중복 접근하지 않으려는 의도에서 PMTiles형식을 기반으로 개발되었다. 그런데 비트마스크의 연속적 배열이 좌표 저장 공간을 획기적으로 줄일 수 있다는 특징을 깨닫게 되면서, 데이터 인덱스 부분 역시 없어도 되는 경우에 대해 생각해보게 되었다. 그 결과 모든 타일의 데이터가 같은 크기의 저장 공간을 가진다면 데이터 인덱스 역시 없어도 될 것이라는 생각이 떠올랐다.

그렇다면, GeoTIFF 처럼 단일 밴드 혹은 다중 밴드의 저장 형식을 대체할 수도 있지 않을까? QBTiles의 경우 쿼드트리 알고리즘처럼 상위 비트마스크로 데이터가 없는 부분을 큰 단위에서 건너뛸 수 있다. 따라서 전 세계 토지피복 혹은 인구 데이터처럼 희소성이 높을수록 생략할 수 있는 여지가 커지기 때문에 GeoTIFF보다 효율적인 형식이 된다.

## 더 작은 파일, 더 세밀한 접근

GeoTIFF 같은 래스터 포맷은 **전체 직사각형 격자**에 데이터를 저장한다 — 데이터가 없는 픽셀도 공간을 차지한다. 희소(sparse) 데이터셋에서는 그 공간의 대부분이 nodata 값으로 낭비된다.

WorldPop 2025 전세계 인구 격자(1km 해상도)를 보면: 43,200 × 17,280 = **7.46억 픽셀**이지만, 실제 유효 데이터는 **5,100만 셀**(점유율 6.9%)뿐이다. 나머지 93%는 바다와 무인 지역으로, 압축 알고리즘이 처리해야 하는 nodata 값으로 저장된다.

QBTiles의 경우, 이러한 빈 공간들을 파일에 전혀 담지 않을 수 있다. 비트마스크 트리가 *어떤* 셀이 존재하는지 인코딩하고, 존재하는 셀만 값을 저장한다. 즉, 빈 공간의 비용은 0바이트다.

WorldPop의 2025년 Populcation Count 데이터는 276MB다. 이 데이터를 QBTiles로 변환하면 204MB(74%)로 줄어든다.

용량이 적은데도 불구하고 range-request를 통한 접근은 1 셀 단위로 가능하다.GeoTIFF가 512x512 pixel 단위로 접근 가능한 것과는 달리,  8.7MB의 압축된 비트마스크 인덱스를 받아서 메모리에 올려두면, 1cell 단위로 트래픽 낭비 없이 데이터를 요청하고 받을 수 있다. 물론, 하나의 공간적 영역을 연속적인 구간으로 분할해야 하므로 요청 회수가 증가하기는 하지만, 일반적인 클라이언트 환경에서 동시 요청을 보낼 경우 데이터 전체 응답 시간은 더 빠르다. 데이터 희소 영역의 경우 GeoTIFF 대비 1/10 이하로 다운로드 용량이 작기 때문이다.

클라우드에 최적화 된 파일 포맷, 즉 range-request가 가능한 포맷의 경우 파일 크기와 접근 단위는 보통 트레이드오프 관계다 — 접근 단위가 세밀할수록 메타데이터 오버헤드가 커져서 파일 크기가 늘어날 수 밖에 없다. 그렇지만 QBTiles는 빈 셀 제거를 위한 비트마스크가 *동시에* 셀 단위 주소 지정을 위한 공간 인덱스 역할을 하기 때문에 둘 다 달성할 수 있다.

> **래스터 포맷은 빈 공간에 비용을 지불한다. QBTiles는 그렇지 않다.**

데이터가 희소할수록 이점이 커진다. 아프리카처럼 존재하는 인구 셀이 희소한 지역에서는 부분 추출의 경우 내려받는 데이터가 1/10 이하가 된다.

---

## 실측 성능

### WorldPop 벤치마크 (5,100만 셀)

- 7.46억 셀 중 51,297,957개 유효 (점유율 6.9%)

아마도 빈 공간을 채워넣을 수 밖에 없는 래스터 형식인 GeoTIFF와 유효셀만 골라서 저장한 QBTiles와 비교하는건 불공평하다고 생각할 수도 있다.

그래서 GeoParquet로도 변환하여 비교해보았다.


| Format                   | Size       | Ratio    | Partial access     | Access unit                  |
| ------------------------ | ---------- | -------- | ------------------ | ---------------------------- |
| FlatGeobuf               | 6,001 MB   | 29.4x    | Range Request      | per feature (~40+ bytes)     |
| GeoParquet               | 700 MB     | 3.4x     | full download only | row group (engine-dependent) |
| Parquet float32 (snappy) | 312 MB     | 1.5x     | full download only | -                            |
| Parquet float32 (gzip)   | 284 MB     | 1.4x     | full download only | -                            |
| GeoTIFF float32 (COG)    | 276 MB     | 1.4x     | Range Request      | 512×512 block                |
| **QBTiles float32**      | **204 MB** | **1.0x** | **Range Request**  | **per cell (4 bytes)**       |


모두를 비교해봐도 QBTiles가 가장 크기가 작다. 게다가 range-request를 셀 단위로 해낼 수 있다는 유연성 또한 갖추고 있다.

파이썬 qbtiles라이브러리에서 GeoTIFF를 QBTIles로 변환할 수 있는 함수를 제공하므로, 직접 비교해보고 판단해볼 수 있다.

### 벡터 포맷과 비교

이 샘플에서 QBTiles 전체 파일 용량은 204MB인데, 140Byte 이하 크기의 헤더, 9MB의 압축된 인덱스, 195M의 비압축 float32 연속 데이터로 구성된다. 아래 표에 유사 벡터 포맷과 비교해보았다.

셀 단위 Range Request 접근이 가능한 공간 데이터에서, 기존 벡터 포맷들은 부분적인 해법만을 제공한다:


|                       | QBTiles                           | FlatGeobuf                     | GeoParquet                        |
| --------------------- | --------------------------------- | ------------------------------ | --------------------------------- |
| Spatial index         | Bitmask tree (8.7 MB / 51M cells) | R-tree (tens of MB / 51M)      | Row group metadata                |
| Access granularity    | Per cell (4 bytes)                | Per feature (~40+ bytes)       | Per row group (thousands of rows) |
| ID/coordinate storage | 0 (tree implies position)         | lon/lat per feature (16 bytes) | lon/lat per row (16 bytes)        |
| 51M cells storage     | 204 MB                            | 6,001 MB                       | 700 MB                            |
| Best for              | Regular grids                     | Irregular vector features      | Tabular analytics                 |


FlatGeobuf는 불규칙 벡터 feature에 최적화된 포맷이다. 정규 격자 51M 포인트에서는 feature당 R-tree 인덱스 엔트리 + FlatBuffers wrapper 오버헤드(~98 bytes/feature)가 지배적이어서 비정상적으로 크다. 불규칙 벡터 데이터에서는 합리적인 크기를 보인다.

FlatGeobuf가 가장 유사하다 — bbox 기반 Range Request로 개별 피처를 가져올 수 있다. 하지만 정규 격자에서 셀마다 좌표를 명시적으로 저장하는 것은 낭비다: 5,100만 × 16바이트(lon/lat double) = 좌표만 800MB.

---

## Cloud Optimized Format : Range Request를 통한 부분 접근

비트마스크 구조는 Cloud Optimized GeoTIFF(COG)와 유사한 부분 접근 패턴을 지원하지만, 블록 단위가 아닌 셀 단위 해상도로 가능하다.

클라이언트는:

1. 비트마스크만 다운로드 (5,100만 셀에 대해 8.7 MB gzip) — 한 번만
2. 임의 셀의 정확한 바이트 오프셋 계산: offset = leaf_index `x 4`
3. HTTP Range Request로 필요한 셀만 가져오기

그리고 만약 8.7MB의 초기 오버헤드가 과도하다는 생각이 든다면 인덱스의 크기를 줄일 수도 있다. 즉, 인덱스를 2-3단계 줄이면서 접근 셀의 단위를 4x4 혹은 8x8로 키우는 방향으로 최적화의 시도가 가능하다.

1개의 비트마스크가 담당하는 공간을 1 cell이 아닌 16 cell, 64 cell로 키우게 되면 약간의 공간이 더 낭비되겠지만, 초기 로딩의 부담은 그 만큼 줄어들게 된다. 이러한 trade-off를 고려하는 적정 수준의 설계는 현재 QBTiles의 규격(specification)과 API로 가능하다.

### 파일 크기에 따른 두 가지 접근 전략


| Strategy      | Initial download | Access granularity         |
| ------------- | ---------------- | -------------------------- |
| Full download | 51 MB (gzip)     | Instant client-side access |
| Bitmask only  | 8.7 MB           | Per-cell Range Request     |


#### 전략 1: 전체 다운로드

만약 데이터가 정수 형식이라면 공간적 자기 상관성에 의해 유사한 수치들이 연속적으로 배열되므로 압축률이 꽤 좋아진다. 전세계같은 넓은 영역의 전체 파일을 받는 부담도 많이 줄어드는데, WorldPop전세계 인구의 경우 반올림해서 정수로 저장하면 압축시 용량이 51MB까지 줄어든다. 그렇다면 전체 gzip 파일을 다운로드하고, 압축 해제 후 검색 테이블을 구축한다. 클라이언트가 전체 데이터셋을 대화식으로 탐색해야 할 때 적합하다.

#### 전략 2: 비트마스크 우선 (현재 — [라이브 데모](https://vuski.github.io/qbtiles/demo/range-request/))

비트마스크 섹션을 다운로드한 후, BFS 리프 순서로 바이트 오프셋을 계산한다:

```
offset = data_section_start + leaf_index × value_size
```

파일 레이아웃:

```
[bitmask section: 12.7 MB raw, 8.7 MB gzip]  ← 한 번 다운로드
[value section: 196 MB, float32 × 51M]        ← 셀 단위 Range Request
```

### Cloud에서의 사용시 요청 수 vs 전송량 트레이드오프

데이터 파일을 클라우드나 원격 서버에 올려놓고 직사각형 영역의 range-request를 하는 경우를 생각해보자. 직사각형을 연속 구간으로 분리해야 하므로 요청 수는 다소 늘어나겠지만, 필요한 데이터만을 받으므로 다운로드 전체 용량은 33%로 줄어드는 경우도 있다.

ex) 대한민국 대상, 약 2° × 2° 영역 선택에 대한 실제 비교:


|                    | QBTiles            | COG               |
| ------------------ | ------------------ | ----------------- |
| Requests           | 7                  | 2                 |
| Bytes              | 23.1 KB            | 768 KB            |
| Cells retrieved    | 4,576              | 76,989            |
| Access granularity | Per cell (4 bytes) | Per 512×512 block |


COG의 경우 요청 회수는 더 적지만, **33배 더 많은 데이터**를 전송받아야만 한다. 무론 이 약간의 트레이드 오프 관계는 사용자의 작업 환경에 따라 최종 선택을 바꿀 수도 있게 만든다.

**실제 요청 오버헤드:**

- HTTP/2+ (Cloudflare R2 등 CDN 표준): 단일 연결, 다중화 — 7개 요청이 추가 핸드셰이크 비용 없이 거의 동시에 실행
- 요청당 오버헤드: ~200–300바이트 헤더 × 7 = ~2 KB, 무시할 수준
- 요청 수가 병목이 되는 것은 ~50개 요청 이상에서 서브KB 페이로드일 때뿐

**전송 비용은 바이트에 비례:**

- CDN 이그레스 과금: 바이트 단위
- 모바일 데이터 요금: 바이트 단위
- 모바일 배터리 소모: 라디오 온 시간에 비례, 바이트에 의해 결정
- 저속/계량 네트워크 (3G, 위성): 33배 차이는 33배 대기 시간

QBTiles의 `mergeRanges` (간격 ≤ 256 인덱스 → 병합)가 이를 균형 잡는다: 인접한 셀들이 완벽하게 연속되지 않더라도 하나의 요청으로 합쳐져, 요청 수를 낮게 유지하면서 셀 단위 정밀도를 보존한다.

**결론:** HTTP/2 시대에는, **적은 바이트 + 약간 더 많은 요청 >>> 적은 요청 + 훨씬 많은 바이트**, 특히 모바일과 계량 네트워크에서.

### 데모: QBTiles vs COG Range Request

---

## 클라우드 워커의 이용으로 초기 인덱스 비용을 제로로

### 서버 사이드 (Lambda / Worker)

서버 사이드 컴퓨트 레이어(Lambda, Cloudflare Worker 등)를 추가하면 클라이언트는 초기 인덱스마저 다운 받을 필요가 없다.  QBTiles의 단점마저 사라진다는 의미다.

클라이언트 전용 모드에서 QBTiles는 첫 쿼리 전에 비트마스크 인덱스(~8.7 MB)를 다운로드해야 한다. 따라서 누군가 접속해서 1–2개 쿼리만 보내고 끝나는 사례에서는 COG 처럼 초기 비용 없는 모델이 총 전송량이 더 적을 수 있다. 

그렇지만, AWS의 Lambda나 Cloudflare의 Worker를 거치는 경우로 셋팅하는 경우에는 이야기가 달라진다. 서버가 비트마스크를 메모리에 보유하고 클라이언트 대신 바이트 오프셋을 계산하는 경우 클라이언트 사이드의 QBTiles 는 이러한 단점을 찾아보기 어려운 구조로 변모한다.

```
Client → Server:  bbox 로 request (특정 영역의 1회 조회에 10회 이상의 요청 발생할 때가 다수)
      vs
Server → Storage: 정확한 셀에 대한 Range Request (KB)
Server → Client:  bbox 로 1회 request 후 값만 받음(KB)
```

셀 단위 이점이 두 번 적용된다. 

스토리지(S3, R2)와 서버(Lambda, Worker) 사이에의 초기 인덱스 비용은 거의 무시할만하다. 다수의 클라이언트가 요청하더라도 8.7MB는 단 한번만 전송되기 때문이다. 그리고 지속적인 쿼리에도 총 전송량이 적어지므로 내부 네트워크에서 트래픽의 이득을 본다.  

그리고 서버와 클라이언트 사이 역시 마찬가지다. 초기 인덱스마저 다운받을 필요가 없다. 거의 모든 경우 COG보다 작은 데이터가 네트워크를 타고 전달된다. 희소한 지역(예: 사하라, 해안 경계)에서는 격차가 극적이 된다 — 100개 유효 셀이 필요한 쿼리가 QBTiles에서는 스토리지에서 ~400바이트를 전송하지만, COG에서는 ~512 KB를 전송할 때도 있다.

정리하면 두 경우는 아래와 같다.

### 초기 인덱스 비용


| Deployment                  | QBTiles 의 초기 비용         | COG 대비 손익 분기점 |
| --------------------------- | ----------------------- | ------------- |
| Client-only (serverless)    | 8.7 MB bitmask download | ~10 queries   |
| Server-side (Lambda/Worker) | 0 (server holds index)  | **1st query** |


---

# 이진 탐색 알고리즘 : Bitmask의 추가적 이득

쿼드키 정렬 구조는 기본적인 데이터 검색을 넘어선 기능을 가능하게 한다.

## 쿼드키 접두사를 이용한 이진 탐색

디코딩된 QBTiles 엔트리는 쿼드키(Z-order curve) 순서로 정렬되어 있어 공간 계층 구조를 보존한다. 부분 영역 쿼리는 정렬된 배열에 대한 이진 검색으로 축소된다:

```python
shift = 2 * (leaf_zoom - parent_zoom)
qk_min = parent_qk << shift
qk_max = qk_min | ((1 << shift) - 1)
i_start = np.searchsorted(qk_arr, qk_min)
i_end = np.searchsorted(qk_arr, qk_max, side='right')
# → qk_arr[i_start:i_end] is the contiguous subregion
```

이것은 **O(log N)** — 좌표 기반 필터링의 O(N)과 비교된다. Hilbert curve 기반 타일 ID(PMTiles)는 줌 레벨 간에 접두사를 공유하지 않으므로, 이 연속 범위 속성은 쿼드키/Z-order 인코딩에 고유하다.

## 클라이언트 사이드의 경량 공간 분석 포맷

DuckDB가 Parquet 파일을 로컬에서 처리하는 것처럼, QBTiles는 클라이언트 사이드 계산을 위한 경량 공간 분석 포맷으로 사용할 수 있다. 한 번 다운로드하면, 디코딩된 배열이 서버 없이 빠른 공간 연산을 지원한다.

**실측: 대한민국 100m 인구 격자 (93만 셀 × 3값: total, male, female)**


|               | Parquet (x/y + 3 values, gzip) | QBTiles columnar (gzip)              |
| ------------- | ------------------------------ | ------------------------------------ |
| Download      | 2.9 MB                         | **1.7 MB**                           |
| Spatial query | O(N) coordinate scan           | **O(log N) searchsorted on quadkey** |
| Runtime       | Requires DuckDB/WASM (~5 MB)   | Native arrays, no dependency         |


클라이언트 사이드 사용의 핵심 이점:

1. **더 작은 다운로드**: 같은 데이터에 대해 2.9 MB → 1.7 MB (1.7배 차이)
2. **내장 공간 인덱스**: 쿼드키 정렬로 보조 인덱스 구축 없이 O(log N) 범위 쿼리 가능

물론 용량이 그리 크지 않을 때는 선형 탐색인 Parquet이 빠를 수도 있다. 선형 탐색의 경우 바이트 혹은 비트 단위로 전진하기만 하면 되는데, 이진 탐색의 경우 조건문 분기를 거쳐야 하기 때문이다. 손익분기점이 어느 지점인지는 추가적인 실험이 필요하다.

