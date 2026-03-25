/**
 * COG (Cloud Optimized GeoTIFF) query with byte-tracking and result cache.
 */
import { fromUrl, type GeoTIFF, type GeoTIFFImage } from 'geotiff';
import type { BBox } from './geo-constants';

export interface COGStats {
  requests: number;
  bytes: number;
  cells: number;
  timeMs: number;
  tileCount: number;
  cachedTiles: number;
}

export interface COGCellData {
  position: [lng: number, lat: number];
  value: number;
  outside: boolean;
  tileIndex: number;
}

export interface COGChunk {
  bbox: BBox;
}

export interface COGResult {
  cells: COGCellData[];
  chunks: COGChunk[];
  stats: COGStats;
}

export interface COGTrafficPoint {
  request: number;
  bytes: number;
}

function bboxToWindow(
  bbox: BBox,
  image: GeoTIFFImage,
): [left: number, top: number, right: number, bottom: number] {
  const [originX, originY] = image.getOrigin();
  const [resX, resY] = image.getResolution();
  const w = image.getWidth();
  const h = image.getHeight();

  const left = Math.max(0, Math.floor((bbox[0] - originX) / resX));
  const right = Math.min(w, Math.ceil((bbox[2] - originX) / resX));
  const top = Math.max(0, Math.floor((bbox[3] - originY) / resY));
  const bottom = Math.min(h, Math.ceil((bbox[1] - originY) / resY));

  return [left, top, right, bottom];
}

function getChunks(
  image: GeoTIFFImage,
  window: [number, number, number, number],
): COGChunk[] {
  const tileWidth = image.getTileWidth();
  const tileHeight = image.getTileHeight();
  const [originX, originY] = image.getOrigin();
  const [resX, resY] = image.getResolution();
  const [left, top, right, bottom] = window;

  const tileColMin = Math.floor(left / tileWidth);
  const tileColMax = Math.ceil(right / tileWidth);
  const tileRowMin = Math.floor(top / tileHeight);
  const tileRowMax = Math.ceil(bottom / tileHeight);

  const chunks: COGChunk[] = [];
  for (let tr = tileRowMin; tr < tileRowMax; tr++) {
    for (let tc = tileColMin; tc < tileColMax; tc++) {
      const west = originX + tc * tileWidth * resX;
      const east = originX + (tc + 1) * tileWidth * resX;
      const north = originY + tr * tileHeight * resY;
      const south = originY + (tr + 1) * tileHeight * resY;
      chunks.push({
        bbox: [
          Math.min(west, east),
          Math.min(north, south),
          Math.max(west, east),
          Math.max(north, south),
        ],
      });
    }
  }
  return chunks;
}

// ---- Persistent cache ----
let cachedTiff: { url: string; tiff: GeoTIFF; image: GeoTIFFImage } | null = null;

// Cache decoded block data: "tileRow,tileCol" → Float32Array
const blockDataCache = new Map<string, Float32Array>();

export async function queryCOG(
  url: string,
  bbox: BBox,
  signal?: AbortSignal,
  onProgress?: (point: COGTrafficPoint) => void,
): Promise<COGResult> {
  const t0 = performance.now();

  let requests = 0;
  let bytes = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async function trackedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    requests++;
    const res = await originalFetch.call(globalThis, input, init);
    const cl = res.headers.get('content-length');
    if (cl) bytes += parseInt(cl, 10);
    onProgress?.({ request: requests, bytes });
    return res;
  } as typeof fetch;

  try {
    // Reuse GeoTIFF instance
    if (!cachedTiff || cachedTiff.url !== url) {
      const tiff = await fromUrl(url);
      const image = await tiff.getImage();
      cachedTiff = { url, tiff, image };
    }
    const { image } = cachedTiff;

    const userWindow = bboxToWindow(bbox, image);
    const [uLeft, uTop, uRight, uBottom] = userWindow;
    if (uRight <= uLeft || uBottom <= uTop) {
      return { cells: [], chunks: [], stats: { requests, bytes, cells: 0, timeMs: 0, tileCount: 0, cachedTiles: 0 } };
    }

    const tw = image.getTileWidth();
    const th = image.getTileHeight();
    const w = image.getWidth();
    const h = image.getHeight();

    // Block-aligned window
    const blockLeft = Math.floor(uLeft / tw) * tw;
    const blockTop = Math.floor(uTop / th) * th;
    const blockRight = Math.min(w, Math.ceil(uRight / tw) * tw);
    const blockBottom = Math.min(h, Math.ceil(uBottom / th) * th);

    const tileColMin = Math.floor(blockLeft / tw);
    const tileColMax = Math.ceil(blockRight / tw);
    const tileRowMin = Math.floor(blockTop / th);
    const tileRowMax = Math.ceil(blockBottom / th);
    const tileCount = (tileRowMax - tileRowMin) * (tileColMax - tileColMin);

    // Limit: max 100 tiles (~5000×5000 pixels max)
    if (tileCount > 100) {
      throw new Error(`Too many COG tiles (${tileCount}). Reduce selection size.`);
    }

    // Fetch uncached blocks, use cache for the rest
    let cachedTiles = 0;
    const uncachedBlocks: { tr: number; tc: number }[] = [];
    for (let tr = tileRowMin; tr < tileRowMax; tr++) {
      for (let tc = tileColMin; tc < tileColMax; tc++) {
        if (blockDataCache.has(`${tr},${tc}`)) {
          cachedTiles++;
        } else {
          uncachedBlocks.push({ tr, tc });
        }
      }
    }

    if (uncachedBlocks.length > 0) {
      // Fetch entire block-aligned region in one readRasters call
      const rasters = await image.readRasters({
        window: [blockLeft, blockTop, blockRight, blockBottom],
        samples: [0],
      });
      const data = rasters[0] as Float32Array;
      const bWidth = blockRight - blockLeft;

      // Split into per-block arrays and cache
      for (const { tr, tc } of uncachedBlocks) {
        const bLeft = tc * tw;
        const bTop2 = tr * th;
        const bRight = Math.min(w, (tc + 1) * tw);
        const bBottom = Math.min(h, (tr + 1) * th);
        const bW = bRight - bLeft;
        const bH = bBottom - bTop2;
        const blockData = new Float32Array(bW * bH);
        for (let row = 0; row < bH; row++) {
          const srcOffset = (bTop2 - blockTop + row) * bWidth + (bLeft - blockLeft);
          blockData.set(data.subarray(srcOffset, srcOffset + bW), row * bW);
        }
        blockDataCache.set(`${tr},${tc}`, blockData);
      }
    }

    // Build cells from cached blocks
    const [originX, originY] = image.getOrigin();
    const [resX, resY] = image.getResolution();
    const nodata = image.getGDALNoData() ?? -3.4028235e+38;
    const cells: COGCellData[] = [];
    const tilesAcross = tileColMax - tileColMin;

    for (let tr = tileRowMin; tr < tileRowMax; tr++) {
      for (let tc = tileColMin; tc < tileColMax; tc++) {
        const blockData = blockDataCache.get(`${tr},${tc}`);
        if (!blockData) continue;
        const bLeft = tc * tw;
        const bTop2 = tr * th;
        const bRight = Math.min(w, (tc + 1) * tw);
        const bBottom = Math.min(h, (tr + 1) * th);
        const bW = bRight - bLeft;

        for (let i = 0; i < blockData.length; i++) {
          const v = blockData[i];
          if (v === nodata || isNaN(v) || v <= 0) continue;
          const c = bLeft + (i % bW);
          const r = bTop2 + Math.floor(i / bW);
          const lng = originX + (c + 0.5) * resX;
          const lat = originY + (r + 0.5) * resY;
          const outside = c < uLeft || c >= uRight || r < uTop || r >= uBottom;
          const tileIndex = (tr - tileRowMin) * tilesAcross + (tc - tileColMin);
          cells.push({ position: [lng, lat], value: v, outside, tileIndex });
        }
      }
    }

    const chunks = getChunks(image, [blockLeft, blockTop, blockRight, blockBottom]);
    const elapsed = performance.now() - t0;

    return {
      cells,
      chunks,
      stats: { requests, bytes, cells: cells.length, timeMs: elapsed, tileCount, cachedTiles },
    };
  } finally {
    globalThis.fetch = originalFetch;
  }
}
