/**
 * Bitmask-only index deserialization + bbox query + Range merging.
 * Uses Lazy Tree strategy: keep bitmask + childStart + subtreeLeaves,
 * traverse on-demand for each query.
 */
import {
  type BBox,
  type GridParams,
  bboxToRowColRange,
  colToLon,
  rowToLat,
} from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ByteRange {
  byteStart: number;
  byteEnd: number;
  leafIndices: number[];
}

export interface QBTCellData {
  position: [lng: number, lat: number];
  value: number;
  chunkIndex: number;
}

export interface QBTChunk {
  bbox: BBox;
}

export interface BitmaskIndex {
  nibbles: Uint8Array;
  childStart: Uint32Array;
  subtreeLeaves: Uint32Array;
  totalLeaves: number;
  zoom: number;
}

export interface QueryResult {
  leafIndices: number[];
  rows: number[];
  cols: number[];
}

export interface TrafficPoint {
  request: number;
  bytes: number;
}

// ---------------------------------------------------------------------------
// Deserialization
// ---------------------------------------------------------------------------

function popcount4(n: number): number {
  return ((n >> 3) & 1) + ((n >> 2) & 1) + ((n >> 1) & 1) + (n & 1);
}

/**
 * Deserialize a bitmask-only buffer into a lazy tree index.
 * @param buffer - Decompressed bitmask buffer (not gzipped)
 * @param zoom - Quadtree leaf zoom level
 * @param onProgress - Optional progress callback
 */
export async function deserializeBitmaskIndex(
  buffer: ArrayBuffer,
  zoom: number,
  onProgress?: (msg: string) => void,
): Promise<BitmaskIndex> {
  const view = new DataView(buffer);
  const bitmaskByteLen = view.getUint32(0); // big-endian

  onProgress?.('Unpacking bitmask...');
  const count = bitmaskByteLen * 2;
  const nibbles = new Uint8Array(count);
  for (let i = 0; i < bitmaskByteLen; i++) {
    const byte = view.getUint8(4 + i);
    nibbles[i * 2] = byte >> 4;
    nibbles[i * 2 + 1] = byte & 0x0f;
  }
  let nibLen = count;
  while (nibLen > 0 && nibbles[nibLen - 1] === 0) nibLen--;

  onProgress?.(`Computing child offsets (${nibLen.toLocaleString()} nodes)...`);
  await yieldUI();

  const childStart = new Uint32Array(nibLen);
  let levelStart = 0;
  let levelEnd = 1;
  let nextChild = 1;

  while (levelStart < levelEnd && levelStart < nibLen) {
    for (let i = levelStart; i < levelEnd && i < nibLen; i++) {
      childStart[i] = nextChild;
      nextChild += popcount4(nibbles[i]);
    }
    levelStart = levelEnd;
    levelEnd = nextChild;

    if (levelEnd - levelStart > 1_000_000) {
      onProgress?.(`Child offsets... level ${levelStart.toLocaleString()}`);
      await yieldUI();
    }
  }

  onProgress?.('Computing subtree leaf counts...');
  await yieldUI();

  const subtreeLeaves = new Uint32Array(nibLen);
  const CHUNK = 2_000_000;

  for (let i = nibLen - 1; i >= 0; i--) {
    const pc = popcount4(nibbles[i]);
    const firstChild = childStart[i];

    if (firstChild >= nibLen || pc === 0) {
      subtreeLeaves[i] = pc;
    } else {
      let sum = 0;
      for (let c = 0; c < pc; c++) {
        const ci = firstChild + c;
        sum += ci < nibLen ? subtreeLeaves[ci] : 1;
      }
      subtreeLeaves[i] = sum;
    }

    if (i % CHUNK === 0) {
      onProgress?.(`Subtree counts... ${((nibLen - i) / nibLen * 100).toFixed(0)}%`);
      await yieldUI();
    }
  }

  const totalLeaves = subtreeLeaves[0];
  onProgress?.(`Index ready: ${totalLeaves.toLocaleString()} cells`);

  return {
    nibbles: nibbles.subarray(0, nibLen),
    childStart,
    subtreeLeaves,
    totalLeaves,
    zoom,
  };
}

function yieldUI(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// Spatial query
// ---------------------------------------------------------------------------

/**
 * Query bitmask index for leaves within a bbox.
 * @param index - Deserialized bitmask index
 * @param bbox - Geographic bounding box
 * @param grid - Grid parameters for coordinate conversion
 */
export function queryBbox(index: BitmaskIndex, bbox: BBox, grid: GridParams): QueryResult {
  const { colMin, colMax, rowMin, rowMax } = bboxToRowColRange(
    bbox, grid.originLon, grid.originLat, grid.pixelDeg, grid.rasterCols, grid.rasterRows,
  );
  const { nibbles, childStart, subtreeLeaves, zoom } = index;
  const leafIndices: number[] = [];
  const rows: number[] = [];
  const cols: number[] = [];

  const stack: number[][] = [[0, 0, 0, 0, 0, 0]];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const [nodeIdx, nodeRow, nodeCol, nodeZoom, startLeafOffset] = frame;
    let childOrd = frame[5];

    const mask = nibbles[nodeIdx];
    const firstChild = childStart[nodeIdx];

    let leafOffset = startLeafOffset;
    let ord = 0;
    for (let i = 0; i < 4 && ord < childOrd; i++) {
      if (!(mask & (8 >> i))) continue;
      const ci = firstChild + ord;
      leafOffset += ci < nibbles.length ? subtreeLeaves[ci] : 1;
      ord++;
    }

    let found = false;
    for (let i = 0; i < 4; i++) {
      if (!(mask & (8 >> i))) continue;
      let thisOrd = 0;
      for (let j = 0; j < i; j++) {
        if (mask & (8 >> j)) thisOrd++;
      }
      if (thisOrd < childOrd) continue;

      const childRow = (nodeRow << 1) | ((i >> 1) & 1);
      const childCol = (nodeCol << 1) | (i & 1);
      const childZoom = nodeZoom + 1;
      const ci = firstChild + thisOrd;

      const cellSize = 1 << (zoom - childZoom);
      const crMin = childRow * cellSize;
      const crMax = crMin + cellSize - 1;
      const ccMin = childCol * cellSize;
      const ccMax = ccMin + cellSize - 1;

      if (crMax < rowMin || crMin > rowMax || ccMax < colMin || ccMin > colMax) {
        leafOffset += ci < nibbles.length ? subtreeLeaves[ci] : 1;
        continue;
      }

      if (childZoom === zoom) {
        if (childRow < grid.rasterRows && childCol < grid.rasterCols) {
          leafIndices.push(leafOffset);
          rows.push(childRow);
          cols.push(childCol);
        }
        leafOffset += 1;
      } else if (ci < nibbles.length) {
        frame[5] = thisOrd + 1;
        stack.push([ci, childRow, childCol, childZoom, leafOffset, 0]);
        found = true;
        break;
      }
    }

    if (!found) {
      stack.pop();
    }
  }

  return { leafIndices, rows, cols };
}

// ---------------------------------------------------------------------------
// Range merging + fetch
// ---------------------------------------------------------------------------

export function mergeRanges(indices: number[], maxGap = 256): ByteRange[] {
  if (indices.length === 0) return [];

  const sorted = indices.slice().sort((a, b) => a - b);
  const ranges: ByteRange[] = [];

  let rangeStart = sorted[0];
  let rangeEnd = sorted[0];
  let leafIndices = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - rangeEnd <= maxGap) {
      rangeEnd = sorted[i];
      leafIndices.push(sorted[i]);
    } else {
      ranges.push({ byteStart: rangeStart * 4, byteEnd: rangeEnd * 4 + 3, leafIndices });
      rangeStart = sorted[i];
      rangeEnd = sorted[i];
      leafIndices = [sorted[i]];
    }
  }
  ranges.push({ byteStart: rangeStart * 4, byteEnd: rangeEnd * 4 + 3, leafIndices });

  return ranges;
}

// Persistent client-side cache
const leafCache = new Map<number, number>();

export function clearLeafCache(): void {
  leafCache.clear();
}

export async function fetchRanges(
  url: string,
  ranges: ByteRange[],
  signal?: AbortSignal,
  onProgress?: (point: TrafficPoint) => void,
): Promise<{
  values: Map<number, number>;
  totalBytes: number;
  requestCount: number;
  estimatedBytes: number;
  estimatedRequests: number;
  cachedCells: number;
}> {
  const values = new Map<number, number>();
  let totalBytes = 0;
  let requestCount = 0;

  const uncachedRanges: ByteRange[] = [];
  for (const range of ranges) {
    const uncachedIndices: number[] = [];
    for (const leafIdx of range.leafIndices) {
      const cached = leafCache.get(leafIdx);
      if (cached !== undefined) {
        if (!isNaN(cached) && cached > 0) {
          values.set(leafIdx, cached);
        }
      } else {
        uncachedIndices.push(leafIdx);
      }
    }
    if (uncachedIndices.length > 0) {
      const remerged = mergeRanges(uncachedIndices);
      for (const r of remerged) uncachedRanges.push(r);
    }
  }

  await Promise.all(
    uncachedRanges.map(async (range) => {
      const res = await fetch(url, {
        headers: { Range: `bytes=${range.byteStart}-${range.byteEnd}` },
        signal,
      });
      requestCount++;
      const buf = await res.arrayBuffer();
      totalBytes += buf.byteLength;
      const f32 = new Float32Array(buf);

      const baseLeafIdx = range.byteStart / 4;
      for (const leafIdx of range.leafIndices) {
        const offset = leafIdx - baseLeafIdx;
        if (offset >= 0 && offset < f32.length) {
          const v = f32[offset];
          leafCache.set(leafIdx, v);
          if (!isNaN(v) && v > 0) {
            values.set(leafIdx, v);
          }
        }
      }
    }),
  );

  const estimatedBytes = ranges.reduce((sum, r) => sum + (r.byteEnd - r.byteStart + 1), 0);
  const estimatedRequests = ranges.length;
  const cachedCells = ranges.reduce((sum, r) => sum + r.leafIndices.length, 0) -
    uncachedRanges.reduce((sum, r) => sum + r.leafIndices.length, 0);

  return { values, totalBytes, requestCount, estimatedBytes, estimatedRequests, cachedCells };
}

// ---------------------------------------------------------------------------
// Cell data + chunk conversion
// ---------------------------------------------------------------------------

export function queryResultToCells(
  result: QueryResult,
  values: Map<number, number>,
  ranges: ByteRange[],
  grid: GridParams,
): QBTCellData[] {
  const leafToChunk = new Map<number, number>();
  for (let ci = 0; ci < ranges.length; ci++) {
    for (const li of ranges[ci].leafIndices) {
      leafToChunk.set(li, ci);
    }
  }

  const cells: QBTCellData[] = [];
  for (let i = 0; i < result.leafIndices.length; i++) {
    const li = result.leafIndices[i];
    const v = values.get(li);
    if (v === undefined) continue;
    cells.push({
      position: [
        colToLon(result.cols[i], grid.originLon, grid.pixelDeg),
        rowToLat(result.rows[i], grid.originLat, grid.pixelDeg),
      ],
      value: v,
      chunkIndex: leafToChunk.get(li) ?? 0,
    });
  }
  return cells;
}

export function queryResultToChunks(
  result: QueryResult,
  ranges: ByteRange[],
  grid: GridParams,
): QBTChunk[] {
  const idxMap = new Map<number, number>();
  for (let i = 0; i < result.leafIndices.length; i++) {
    idxMap.set(result.leafIndices[i], i);
  }

  return ranges.map((range) => {
    let minRow = Infinity, maxRow = -Infinity;
    let minCol = Infinity, maxCol = -Infinity;

    for (const li of range.leafIndices) {
      const ri = idxMap.get(li);
      if (ri === undefined) continue;
      const r = result.rows[ri];
      const c = result.cols[ri];
      if (r < minRow) minRow = r;
      if (r > maxRow) maxRow = r;
      if (c < minCol) minCol = c;
      if (c > maxCol) maxCol = c;
    }
    if (minRow === Infinity) return null;

    const half = grid.pixelDeg / 2;
    return {
      bbox: [
        colToLon(minCol, grid.originLon, grid.pixelDeg) - half,
        rowToLat(maxRow, grid.originLat, grid.pixelDeg) - half,
        colToLon(maxCol, grid.originLon, grid.pixelDeg) + half,
        rowToLat(minRow, grid.originLat, grid.pixelDeg) + half,
      ] as BBox,
    };
  }).filter(Boolean) as QBTChunk[];
}
