# QBTiles

**QBTiles** (Quadkey Bitmask Tiles)는 존재하는 위치를 트리 구조로 암시하여 ID 저장 비용을 0으로 만드는 공간 데이터 포맷이다.

타일/셀의 존재 여부를 BFS 순서의 **4-bit bitmask**로 저장한다. 각 항목의 위치는 트리 구조에 의해 암시되므로 **ID도, 좌표도 저장하지 않는다**.

## 왜 QBTiles인가?

- **더 작지만 더 정밀한 접근**: PMTiles보다 20–30% 작은 인덱스, COG의 512×512 블록 대비 셀 단위 Range Request 지원. [비교 보기 →](data-container.md)
- **빈 공간은 건너뜀**: bitmask 트리는 존재하는 셀만 저장 — nodata에 바이트를 낭비하지 않음
- **3가지 모드 지원**: 타일 아카이브 (variable-entry), 래스터 그리드 (fixed row), 압축 그리드 (fixed columnar)
- **인덱스 재사용**: SHA-256으로 동일한 공간 구조를 가진 시계열 파일 간 인덱스 재사용 가능
- **클라우드 네이티브**: HTTP Range Request를 통한 서버리스 서빙 (S3, R2 등)

## 설치

```bash
pip install qbtiles    # Python — build & write QBT files
npm install qbtiles    # TypeScript — read & query in the browser
```

## 빠른 시작

### Python — QBT 파일 생성

```python
import qbtiles as qbt

# Mode 1: Tile archive — from a folder of z/x/y tiles (e.g., tiles/5/27/12.mvt)
qbt.build("korea_tiles.qbt", folder="tiles/")

# Mode 2: Columnar — coordinates + multiple value columns
# coords: list of (x, y) in the target CRS
# columns: dict of column_name → value list (same length as coords)
# cell_size: grid cell size in CRS units (meters for EPSG:5179)
# → zoom, origin, extent are auto-calculated from coords and cell_size
qbt.build("population.qbt.gz",
    coords=list(zip(df["x"], df["y"])),         # [(950000, 1950000), ...]
    columns={"total": totals, "male": males, "female": females},
    cell_size=100, crs=5179)                     # 100m grid, Korean CRS

# Mode 3: Fixed row — coordinates + single value array (for Range Request)
# values: flat list of numbers (one per cell)
# entry_size: bytes per cell (4 for float32)
qbt.build("global_pop.qbt",
    coords=list(zip(lons, lats)),                # [(-73.99, 40.75), ...]
    values=population,                           # [52.3, 41.2, ...]
    cell_size=1000, entry_size=4,                # 1km grid, 4 bytes/cell
    fields=[{"type": qbt.TYPE_FLOAT32, "name": "pop"}])

# GeoTIFF → QBTiles conversion (cell_size, CRS, extent auto-detected)
qbt.build("worldpop.qbt", geotiff="worldpop_2025.tif")
```

### TypeScript — 읽기 및 쿼리

```typescript
import { openQBT } from "qbtiles";

// openQBT reads the header, detects the mode, and loads data automatically.

// Mode 1: Tile archive — serve MVT/PNG tiles from a single .qbt file
const tiles = await openQBT("korea_tiles.qbt");
const tile = await tiles.getTile(7, 109, 49); // ArrayBuffer (gzip MVT) | null
tiles.addProtocol(maplibregl, "qbt"); // one-line MapLibre integration

// Mode 3: Fixed row — per-cell Range Request on a remote file
const grid = await openQBT("https://cdn.example.com/global_pop.qbt");
const cells = await grid.query([126, 35, 128, 37]); // [west, south, east, north]
// → Array<{ position: [lng, lat], value: number }>

// Mode 2: Columnar — downloads entire file, queries in memory
const pop = await openQBT("population.qbt.gz");
pop.columns!.get("total")!; // number[931495] — direct access
const result = await pop.query([126, 35, 128, 37]);
// → Array<{ position: [lng, lat], values: {total: 523, male: 261, female: 262} }>
```

## 3가지 모드

| Mode               | Flags | 용도                     | 비교 대상(유사 형식) |
| ------------------ | ----- | ------------------------ | -------------------- |
| **Variable-entry** | `0x0` | 타일 아카이브 (MVT, PNG) | PMTiles              |
| **Fixed row**      | `0x1` | 래스터 그리드            | COG (GeoTIFF)        |
| **Fixed columnar** | `0x3` | 압축 그리드              | Parquet              |

## 프로젝트 구조

```
src/
  python/qbtiles.py          — Python library: build(), quadtree, QBT write/read
  typescript/qbtiles.ts      — TypeScript entry point: re-exports all modules
  typescript/qbt.ts          — Unified reader: QBT class, openQBT(), registerCRS()
  typescript/qbt-header.ts   — Header parser (parseQBTHeader)
  typescript/qbt-reader.ts   — Low-level reader (loadQBTVariable, loadQBTColumnar)
  typescript/bitmask-index.ts — Lazy tree index, spatial query, Range Request
  typescript/types.ts        — Shared types (BBox, GridParams, coord utils)
  cpp/                       — Native Hilbert→quadkey encoder (pybind11, optional)
demo-src/                    — Vite + React demo source (4 pages + landing)
docs/                        — MkDocs documentation site source
examples/                    — Sample data files (.qbt, .qbt.gz, .pmtiles)
dist/                        — npm build output (ESM + CJS + .d.ts)
```

## 라이선스

MIT
