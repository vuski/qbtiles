/**
 * Bitmask-only index deserialization + bbox query + Range merging.
 * Uses Lazy Tree strategy: keep bitmask + childStart + subtreeLeaves,
 * traverse on-demand for each query. ~120MB memory for 51M cells.
 */
import {
  type BBox,
  ZOOM,
  RASTER_COLS,
  RASTER_ROWS,
  bboxToRowColRange,
  colToLon,
  rowToLat,
} from './geo-constants';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ByteRange {
  byteStart: number;
  byteEnd: number; // inclusive
  leafIndices: number[];
}

export interface QBTCellData {
  position: [lng: number, lat: number];
  value: number;
  chunkIndex: number; // which merged byte range this cell belongs to
}

export interface QBTChunk {
  bbox: BBox;
}

export interface BitmaskIndex {
  nibbles: Uint8Array;
  childStart: Uint32Array;
  subtreeLeaves: Uint32Array;
  totalLeaves: number;
}

// ---------------------------------------------------------------------------
// Deserialization
// ---------------------------------------------------------------------------

function popcount4(n: number): number {
  return ((n >> 3) & 1) + ((n >> 2) & 1) + ((n >> 1) & 1) + (n & 1);
}

export async function deserializeBitmaskIndex(
  buffer: ArrayBuffer,
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
  // Trim trailing padding
  let nibLen = count;
  while (nibLen > 0 && nibbles[nibLen - 1] === 0) nibLen--;

  onProgress?.(`Computing child offsets (${nibLen.toLocaleString()} nodes)...`);
  await yieldUI();

  // Compute childStart: BFS level-by-level
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

    // Yield every few levels to avoid blocking
    if (levelEnd - levelStart > 1_000_000) {
      onProgress?.(`Child offsets... level ${levelStart.toLocaleString()}`);
      await yieldUI();
    }
  }

  onProgress?.('Computing subtree leaf counts...');
  await yieldUI();

  // Compute subtreeLeaves bottom-up (reverse BFS order)
  const subtreeLeaves = new Uint32Array(nibLen);
  const CHUNK = 2_000_000;

  for (let i = nibLen - 1; i >= 0; i--) {
    const pc = popcount4(nibbles[i]);
    const firstChild = childStart[i];

    if (firstChild >= nibLen || pc === 0) {
      // Children are beyond the tree → they are actual data leaves
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
  };
}

function yieldUI(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// Spatial query — DFS traversal with leaf offset tracking
// ---------------------------------------------------------------------------

export interface QueryResult {
  leafIndices: number[];
  rows: number[];
  cols: number[];
}

export function queryBbox(index: BitmaskIndex, bbox: BBox): QueryResult {
  const { colMin, colMax, rowMin, rowMax } = bboxToRowColRange(bbox);
  const { nibbles, childStart, subtreeLeaves } = index;
  const leafIndices: number[] = [];
  const rows: number[] = [];
  const cols: number[] = [];

  // Iterative DFS with explicit stack to avoid call-stack overflow on deep trees
  // Stack entry: [nodeIdx, nodeRow, nodeCol, nodeZoom, leafOffset, childOrd]
  // childOrd tracks which of the 4 children we're about to process
  const stack: number[][] = [[0, 0, 0, 0, 0, 0]];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const [nodeIdx, nodeRow, nodeCol, nodeZoom, startLeafOffset] = frame;
    let childOrd = frame[5]; // mutable child iterator

    const mask = nibbles[nodeIdx];
    const firstChild = childStart[nodeIdx];

    // Compute leafOffset for current childOrd position
    // We need to know how many leaves to skip for children before childOrd
    let leafOffset = startLeafOffset;
    // Fast-forward: recompute from childOrd=0 (we could cache, but 4 iterations max)
    let ord = 0;
    for (let i = 0; i < 4 && ord < childOrd; i++) {
      if (!(mask & (8 >> i))) continue;
      const ci = firstChild + ord;
      leafOffset += ci < nibbles.length ? subtreeLeaves[ci] : 1;
      ord++;
    }

    // Continue from childOrd
    let found = false;
    for (let i = 0; i < 4; i++) {
      if (!(mask & (8 >> i))) continue;
      // Count which ordinal child this is
      let thisOrd = 0;
      for (let j = 0; j < i; j++) {
        if (mask & (8 >> j)) thisOrd++;
      }
      if (thisOrd < childOrd) continue; // already processed

      const childRow = (nodeRow << 1) | ((i >> 1) & 1);
      const childCol = (nodeCol << 1) | (i & 1);
      const childZoom = nodeZoom + 1;
      const ci = firstChild + thisOrd;

      // Spatial extent of this child
      const cellSize = 1 << (ZOOM - childZoom);
      const crMin = childRow * cellSize;
      const crMax = crMin + cellSize - 1;
      const ccMin = childCol * cellSize;
      const ccMax = ccMin + cellSize - 1;

      if (crMax < rowMin || crMin > rowMax || ccMax < colMin || ccMin > colMax) {
        // No overlap — skip subtree
        leafOffset += ci < nibbles.length ? subtreeLeaves[ci] : 1;
        continue;
      }

      if (childZoom === ZOOM) {
        // Leaf
        if (childRow < RASTER_ROWS && childCol < RASTER_COLS) {
          leafIndices.push(leafOffset);
          rows.push(childRow);
          cols.push(childCol);
        }
        leafOffset += 1;
      } else if (ci < nibbles.length) {
        // Descend — save next childOrd and push child frame
        frame[5] = thisOrd + 1;
        stack.push([ci, childRow, childCol, childZoom, leafOffset, 0]);
        found = true;
        break; // process child first (DFS)
      }
    }

    if (!found) {
      stack.pop(); // all children processed
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

export interface TrafficPoint {
  request: number;   // cumulative request count
  bytes: number;     // cumulative bytes
}

// Persistent client-side cache: leafIndex → float32 value
const leafCache = new Map<number, number>();

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

  // First, fill from cache and build uncached ranges
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
      // Re-merge uncached indices into tight ranges
      const remerged = mergeRanges(uncachedIndices);
      for (const r of remerged) uncachedRanges.push(r);
    }
  }

  // Fetch uncached ranges in parallel
  await Promise.all(
    uncachedRanges.map(async (range) => {
      const res = await fetch(url, {
        headers: { Range: `bytes=${range.byteStart}-${range.byteEnd}` },
        signal,
      });
      const buf = await res.arrayBuffer();
      totalBytes += buf.byteLength;
      requestCount++;
      const f32 = new Float32Array(buf);

      const baseLeafIdx = range.byteStart / 4;
      for (const leafIdx of range.leafIndices) {
        const offset = leafIdx - baseLeafIdx;
        if (offset >= 0 && offset < f32.length) {
          const v = f32[offset];
          // Cache ALL fetched cells (including nodata/zero) to avoid re-fetching
          leafCache.set(leafIdx, v);
          if (!isNaN(v) && v > 0) {
            values.set(leafIdx, v);
          }
        }
      }
    }),
  );

  // Compute estimated bytes if there were no cache
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
): QBTCellData[] {
  // Build leafIndex → chunkIndex map
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
      position: [colToLon(result.cols[i]), rowToLat(result.rows[i])],
      value: v,
      chunkIndex: leafToChunk.get(li) ?? 0,
    });
  }
  return cells;
}

/**
 * One bbox per merged byte range — the bounding box of all cells
 * fetched in that single HTTP Range Request.
 */
export function queryResultToChunks(
  result: QueryResult,
  ranges: ByteRange[],
): QBTChunk[] {
  const idxMap = new Map<number, number>();
  for (let i = 0; i < result.leafIndices.length; i++) {
    idxMap.set(result.leafIndices[i], i);
  }

  const PIXEL_DEG = 1 / 120;
  const HALF = PIXEL_DEG / 2;
  const OX = -180;
  const OY = 84;

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

    return {
      bbox: [
        OX + minCol * PIXEL_DEG,
        OY - (maxRow + 1) * PIXEL_DEG,
        OX + (maxCol + 1) * PIXEL_DEG,
        OY - minRow * PIXEL_DEG,
      ] as BBox,
    };
  }).filter(Boolean) as QBTChunk[];
}

// ---------------------------------------------------------------------------
// Strategy A: Full Expand (disabled — OOM on 51M cells, ~1.5GB JS objects)
// Kept for reference / future optimization with Web Worker + SharedArrayBuffer
// ---------------------------------------------------------------------------

/*
export interface FullExpandIndex {
  type: 'full';
  leafRows: Uint16Array;
  leafCols: Uint16Array;
  leafCount: number;
}

export async function deserializeFullExpand(
  buffer: ArrayBuffer,
  onProgress?: (msg: string) => void,
): Promise<FullExpandIndex> {
  const view = new DataView(buffer);
  const bitmaskByteLen = view.getUint32(0);

  onProgress?.('Unpacking bitmask...');
  const nibbles: number[] = [];
  for (let i = 0; i < bitmaskByteLen; i++) {
    const byte = view.getUint8(4 + i);
    nibbles.push(byte >> 4);
    nibbles.push(byte & 0x0f);
  }
  if (nibbles.length > 0 && nibbles[nibbles.length - 1] === 0) nibbles.pop();

  // BFS expansion — collect leaf (row, col)
  // Problem: tempLeaves as Array<[number, number]> creates 51M JS tuple objects → ~1.5GB OOM
  // Fix: use pre-allocated Uint16Array, but requires knowing leafCount first (chicken-and-egg)
  // Alternative: use Lazy Tree strategy (Strategy B) which avoids full expansion
  let queue: Array<[number, number, number]> = [[0, 0, 0]];
  let nibIdx = 0;
  const tempLeaves: Array<[number, number]> = [];

  while (nibIdx < nibbles.length) {
    const nextQueue: Array<[number, number, number]> = [];
    for (const [row, col, z] of queue) {
      if (nibIdx >= nibbles.length) break;
      const mask = nibbles[nibIdx++];
      for (let i = 0; i < 4; i++) {
        if (!(mask & (8 >> i))) continue;
        const childRow = (row << 1) | ((i >> 1) & 1);
        const childCol = (col << 1) | (i & 1);
        const childZoom = z + 1;
        if (childZoom === ZOOM) {
          if (childRow < RASTER_ROWS && childCol < RASTER_COLS) {
            tempLeaves.push([childRow, childCol]);
          }
        } else {
          nextQueue.push([childRow, childCol, childZoom]);
        }
      }
    }
    queue = nextQueue;
  }

  const leafRows = new Uint16Array(tempLeaves.length);
  const leafCols = new Uint16Array(tempLeaves.length);
  for (let i = 0; i < tempLeaves.length; i++) {
    leafRows[i] = tempLeaves[i][0];
    leafCols[i] = tempLeaves[i][1];
  }
  return { type: 'full', leafRows, leafCols, leafCount: tempLeaves.length };
}

export function queryFullExpand(index: FullExpandIndex, bbox: BBox): number[] {
  const { colMin, colMax, rowMin, rowMax } = bboxToRowColRange(bbox);
  const results: number[] = [];
  for (let i = 0; i < index.leafCount; i++) {
    if (index.leafRows[i] >= rowMin && index.leafRows[i] <= rowMax &&
        index.leafCols[i] >= colMin && index.leafCols[i] <= colMax) {
      results.push(i);
    }
  }
  return results;
}
*/
