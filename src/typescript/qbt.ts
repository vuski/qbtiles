/**
 * QBT — Unified reader for all QBTiles modes.
 *
 * Usage:
 *   const qbt = await openQBT('file.qbt');
 *   qbt.getTile(z, x, y)     // variable-entry
 *   qbt.query(bbox)           // all modes
 *   qbt.columns               // columnar
 *   qbt.addProtocol(maplibregl)
 */
import proj4 from 'proj4';
import { parseQBTHeader, type QBTHeader } from './qbt-header';
import {
  deserializeBitmaskIndex, queryBbox, mergeRanges, fetchRanges,
  queryResultToCells, type BitmaskIndex, type QBTCellData,
} from './bitmask-index';
import { type BBox, type GridParams, splitAntimeridian } from './types';
import { readColumnarValues } from './qbt-reader';

// Re-use deserializeQuadtreeIndex from qbtiles.ts would cause circular import.
// Instead, inline the import via dynamic import or duplicate minimal logic.
// We use a direct import of the functions we need from the source files.

export type QBTMode = 'variable' | 'fixed' | 'columnar';

export interface QBTQueryStats {
  requests: number;
  bytes: number;
  cells: number;
  timeMs: number;
}

interface VariableEntry {
  offset: number;
  length: number;
  z: number;
  x: number;
  y: number;
}

// ---- Varint reader (duplicated to avoid circular import) ----
function readVarint(view: DataView, offsetRef: { offset: number }): number {
  let result = 0;
  let shift = 0;
  let offset = offsetRef.offset;
  while (true) {
    const byte = view.getUint8(offset++);
    result |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) break;
    shift += 7;
  }
  offsetRef.offset = offset;
  return result;
}

// ---- Quadkey helpers (duplicated to avoid circular import) ----
function expandChildren(parent: bigint, bitmask: number): bigint[] {
  const children: bigint[] = [];
  for (let i = 0; i < 4; i++) {
    if (bitmask & (1 << (3 - i))) {
      children.push((parent << 2n) | BigInt(i));
    }
  }
  return children;
}

function quadkeyToZXY(qint64: bigint): { z: number; x: number; y: number } {
  let x = 0, y = 0, z = 0, foundPrefix = false;
  for (let shift = 62n; shift >= 0n; shift -= 2n) {
    const digit = (qint64 >> shift) & 0b11n;
    if (!foundPrefix) { if (digit === 0b11n) foundPrefix = true; continue; }
    x = (x << 1) | Number(digit & 1n);
    y = (y << 1) | Number((digit >> 1n) & 1n);
    z += 1;
  }
  return { z, x, y };
}

function tileToQuadkey(z: number, x: number, y: number): bigint {
  let qk = 3n;
  for (let i = z - 1; i >= 0; i--) {
    const digit = ((BigInt(y >> i) & 1n) << 1n) | (BigInt(x >> i) & 1n);
    qk = (qk << 2n) | digit;
  }
  return qk;
}

function deserializeVariableIndex(buffer: ArrayBuffer): Map<bigint, VariableEntry> {
  const view = new DataView(buffer);
  const offsetRef = { offset: 0 };

  const bitmaskLen = view.getUint32(offsetRef.offset);
  offsetRef.offset += 4;

  const bitmasks: number[] = [];
  for (let i = 0; i < bitmaskLen; i++) {
    const byte = view.getUint8(offsetRef.offset++);
    bitmasks.push(byte >> 4);
    bitmasks.push(byte & 0x0f);
  }
  if (bitmasks[bitmasks.length - 1] === 0) bitmasks.pop();

  const quadkeys: bigint[] = [3n];
  let queue: bigint[] = [3n];
  let i = 0;
  while (i < bitmasks.length) {
    const nextQueue: bigint[] = [];
    for (const parent of queue) {
      if (i >= bitmasks.length) break;
      const children = expandChildren(parent, bitmasks[i]);
      quadkeys.push(...children);
      nextQueue.push(...children);
      i += 1;
    }
    queue = nextQueue;
  }

  const run_lengths: number[] = [];
  const lengths: number[] = [];
  for (let i = 0; i < quadkeys.length; i++) run_lengths.push(readVarint(view, offsetRef));
  for (let i = 0; i < quadkeys.length; i++) lengths.push(readVarint(view, offsetRef));

  const offsets: number[] = [];
  for (let i = 0; i < quadkeys.length; i++) {
    const encoded = readVarint(view, offsetRef);
    if (i > 0 && encoded === 0) {
      offsets.push(offsets[i - 1] + lengths[i - 1]);
    } else {
      offsets.push(encoded - 1);
    }
  }

  const entryMap = new Map<bigint, VariableEntry>();
  for (let i = 0; i < quadkeys.length; i++) {
    if (lengths[i] === 0) continue;
    const { z, x, y } = quadkeyToZXY(quadkeys[i]);
    entryMap.set(quadkeys[i], { offset: offsets[i], length: lengths[i], z, x, y });
  }
  return entryMap;
}

// ---- Gzip helper ----
async function decompressGzip(data: Uint8Array): Promise<ArrayBuffer> {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(data as any);
  writer.close();
  return new Response(ds.readable).arrayBuffer();
}

function isGzip(data: Uint8Array): boolean {
  return data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b;
}

// ---- CRS projection setup ----

// Common CRS definitions not built into proj4
const CRS_DEFS: Record<number, string> = {
  5179: '+proj=tmerc +lat_0=38 +lon_0=127.5 +k=0.9996 +x_0=1000000 +y_0=2000000 +ellps=GRS80 +units=m +no_defs',
  5186: '+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs',
  5187: '+proj=tmerc +lat_0=38 +lon_0=127.5 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs',
  3857: '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +no_defs',
  32652: '+proj=utm +zone=52 +datum=WGS84 +units=m +no_defs',
};

/**
 * Register a custom CRS definition for use with openQBT.
 * Call before openQBT() if your file uses a CRS not in the built-in list.
 */
export function registerCRS(epsg: number, proj4Def: string): void {
  CRS_DEFS[epsg] = proj4Def;
}

function setupProjection(crs: number): {
  toWGS84: (x: number, y: number) => [number, number];
  fromWGS84: (lng: number, lat: number) => [number, number];
} {
  if (crs === 4326) {
    return {
      toWGS84: (x: number, y: number) => [x, y] as [number, number],
      fromWGS84: (lng: number, lat: number) => [lng, lat] as [number, number],
    };
  }
  const def = CRS_DEFS[crs];
  if (!def) {
    throw new Error(`Unknown CRS: EPSG:${crs}. Use registerCRS(${crs}, proj4Def) before openQBT().`);
  }
  proj4.defs(`EPSG:${crs}`, def);
  const fwd = proj4(`EPSG:${crs}`, 'EPSG:4326');
  const inv = proj4('EPSG:4326', `EPSG:${crs}`);
  return {
    toWGS84: (x, y) => fwd.forward([x, y]) as [number, number],
    fromWGS84: (lng, lat) => inv.forward([lng, lat]) as [number, number],
  };
}

// ===========================================================================
// QBT class
// ===========================================================================

export class QBT {
  readonly url: string;
  readonly header: QBTHeader;
  readonly mode: QBTMode;

  // Variable-entry
  private _variableIndex: Map<bigint, VariableEntry> | null = null;

  // Fixed row / Columnar
  private _bitmaskIndex: BitmaskIndex | null = null;
  private _grid: GridParams | null = null;
  private _columns: Map<string, number[]> | null = null;
  private _buffer: ArrayBuffer | null = null;  // for columnar (full file in memory)

  // CRS
  private _toWGS84: (x: number, y: number) => [number, number];
  private _fromWGS84: (lng: number, lat: number) => [number, number];

  // Stats
  private _lastStats: QBTQueryStats | null = null;

  // Metadata
  private _metadata: Record<string, any> | null = null;

  constructor(url: string, header: QBTHeader) {
    this.url = url;
    this.header = header;

    const flags = header.flags;
    if (!(flags & 0x1)) {
      this.mode = 'variable';
    } else if (flags & 0x2) {
      this.mode = 'columnar';
    } else {
      this.mode = 'fixed';
    }

    const proj = setupProjection(header.crs);
    this._toWGS84 = proj.toWGS84;
    this._fromWGS84 = proj.fromWGS84;
  }

  /** Number of leaf cells / tile entries */
  get leafCount(): number {
    if (this._variableIndex) return this._variableIndex.size;
    if (this._bitmaskIndex) return this._bitmaskIndex.totalLeaves;
    return 0;
  }

  /** Columnar values (only available in columnar mode) */
  get columns(): Map<string, number[]> | null {
    return this._columns;
  }

  /** Last query statistics */
  get lastStats(): QBTQueryStats | null {
    return this._lastStats;
  }

  /** File metadata (JSON parsed from metadata section, if present) */
  get metadata(): Record<string, any> | null {
    return this._metadata;
  }

  // ---- Variable-entry methods ----

  /** Fetch a single tile by z/x/y. Returns null if not found. */
  async getTile(z: number, x: number, y: number, signal?: AbortSignal): Promise<ArrayBuffer | null> {
    if (this.mode === 'variable') {
      if (!this._variableIndex) throw new Error('Not loaded');
      const qk = tileToQuadkey(z, x, y);
      const entry = this._variableIndex.get(qk);
      if (!entry) return null;
      const start = this.header.valuesOffset + entry.offset;
      const end = start + entry.length - 1;
      const res = await fetch(this.url, {
        headers: { Range: `bytes=${start}-${end}` },
        signal,
      });
      return res.arrayBuffer();
    }

    // Columnar: return cells in the tile's bbox from memory
    if (this.mode === 'columnar') {
      // Could return cells within the tile bounds, but semantically different
      // For now, delegate to query with the tile's bbox
      return null;
    }

    throw new Error(`getTile is not available in ${this.mode} mode`);
  }

  /** Look up a tile entry without fetching data */
  getEntry(z: number, x: number, y: number): VariableEntry | undefined {
    if (!this._variableIndex) return undefined;
    return this._variableIndex.get(tileToQuadkey(z, x, y));
  }

  /** Register as MapLibre custom protocol. Automatically decompresses gzip tiles. */
  addProtocol(maplibregl: any, protocol: string = 'qbtiles'): void {
    if (this.mode !== 'variable') throw new Error(`addProtocol is only for variable mode`);
    if (!this._variableIndex) throw new Error('Not loaded');
    const self = this;
    (maplibregl as any).addProtocol(
      protocol,
      async (params: any, abortController: AbortController) => {
        const parts = params.url.replace(`${protocol}://`, '').split('/').filter(Boolean);
        const [z, x, y] = parts.map(Number);
        const data = await self.getTile(z, x, y, abortController.signal);
        if (!data) return { data: new ArrayBuffer(0) };
        // Decompress gzip if needed (MVT tiles are often gzip-compressed)
        const bytes = new Uint8Array(data);
        if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
          const ds = new DecompressionStream('gzip');
          const w = ds.writable.getWriter();
          w.write(bytes);
          w.close();
          return { data: await new Response(ds.readable).arrayBuffer() };
        }
        return { data };
      },
    );
  }

  // ---- Query (all modes) ----

  /**
   * Query cells/tiles within a bounding box (WGS84).
   *
   * - variable: returns tiles overlapping the bbox at given zoom
   * - fixed row: Range Request for matching cells
   * - columnar: memory lookup for matching cells
   */
  async query(
    bbox: BBox,
    zoom?: number,
    signal?: AbortSignal,
    onProgress?: (p: { request: number; bytes: number }) => void,
  ): Promise<QBTCellData[]> {
    const t0 = performance.now();

    if (this.mode === 'variable') {
      return this._queryVariable(bbox, zoom ?? this.header.zoom, signal);
    }

    if (!this._bitmaskIndex || !this._grid) throw new Error('Not loaded');

    // Convert WGS84 bbox to native CRS if needed
    const nativeBbox = this._bboxToNative(bbox);

    // For custom CRS: queryBbox assumes lat decreases (WGS84 convention).
    // Custom CRS has Y increasing upward, so we build a grid with flipped Y.
    const grid = this._grid;
    let effectiveGrid = grid;
    if (this.header.crs !== 4326) {
      // In custom CRS: row = (y - originY) / pixelDeg (Y increases upward)
      // We flip by setting originLat to top edge and using positive pixelDeg
      const topY = this.header.originY + this.header.extentY;
      effectiveGrid = {
        ...grid,
        originLat: topY,
        pixelDeg: grid.pixelDeg,
        rasterRows: grid.rasterRows,
      };
    }

    const bboxes = this.header.crs === 4326 ? splitAntimeridian(nativeBbox) : [nativeBbox];
    let allLeafIndices: number[] = [];
    let allRows: number[] = [];
    let allCols: number[] = [];
    for (const b of bboxes) {
      const r = queryBbox(this._bitmaskIndex, b, effectiveGrid);
      allLeafIndices = allLeafIndices.concat(r.leafIndices);
      allRows = allRows.concat(r.rows);
      allCols = allCols.concat(r.cols);
    }
    const result = { leafIndices: allLeafIndices, rows: allRows, cols: allCols };

    if (result.leafIndices.length === 0) {
      this._lastStats = { requests: 0, bytes: 0, cells: 0, timeMs: performance.now() - t0 };
      return [];
    }

    if (this.mode === 'fixed') {
      // Range Request
      const ranges = mergeRanges(result.leafIndices, 256, this.header.entrySize);
      const { values, totalBytes, requestCount } = await fetchRanges(
        this.url, ranges, signal, onProgress, this.header.valuesOffset,
      );
      const cells = queryResultToCells(result, values, ranges, this._grid);
      // Convert positions to WGS84
      for (const cell of cells) {
        cell.position = this._toWGS84(cell.position[0], cell.position[1]) as [number, number];
      }
      this._lastStats = {
        requests: requestCount, bytes: totalBytes,
        cells: cells.length, timeMs: performance.now() - t0,
      };
      return cells;
    }

    if (this.mode === 'columnar') {
      // Memory lookup — all columns
      const cells: QBTCellData[] = [];
      const tileSize = this.header.extentX / (1 << this.header.zoom);
      const colEntries = this._columns ? Array.from(this._columns.entries()) : [];
      const firstCol = colEntries.length > 0 ? colEntries[0][1] : null;

      for (let i = 0; i < result.leafIndices.length; i++) {
        const col = result.cols[i];
        const row = result.rows[i];
        const cx = this.header.originX + col * tileSize + tileSize / 2;
        const cy = this.header.originY + row * tileSize + tileSize / 2;
        const [lng, lat] = this._toWGS84(cx, cy);
        const leafIdx = result.leafIndices[i];

        // Build values object with all columns
        const values: Record<string, number> = {};
        for (const [name, arr] of colEntries) {
          values[name] = arr[leafIdx];
        }

        cells.push({
          position: [lng, lat],
          value: firstCol ? firstCol[leafIdx] : 0,
          chunkIndex: 0,
          values,
        });
      }
      this._lastStats = {
        requests: 0, bytes: 0,
        cells: cells.length, timeMs: performance.now() - t0,
      };
      return cells;
    }

    return [];
  }

  /** Convert native CRS coordinate to WGS84 [lng, lat] */
  toWGS84(x: number, y: number): [number, number] {
    return this._toWGS84(x, y);
  }

  /** Convert WGS84 [lng, lat] to native CRS coordinate */
  fromWGS84(lng: number, lat: number): [number, number] {
    return this._fromWGS84(lng, lat);
  }

  /** Get bounding box of a cell/tile in WGS84 */
  getCellBBox(z: number, x: number, y: number): BBox {
    const tileSize = this.header.extentX / (1 << z);
    const minX = this.header.originX + x * tileSize;
    const minY = this.header.originY + y * tileSize;
    const maxX = minX + tileSize;
    const maxY = minY + tileSize;
    const [west, south] = this._toWGS84(minX, minY);
    const [east, north] = this._toWGS84(maxX, maxY);
    return [west, south, east, north];
  }

  // ---- Internal ----

  private _bboxToNative(bbox: BBox): BBox {
    if (this.header.crs === 4326) return bbox;
    const [west, south, east, north] = bbox;
    const [minX, minY] = this._fromWGS84(west, south);
    const [maxX, maxY] = this._fromWGS84(east, north);
    return [minX, minY, maxX, maxY];
  }

  private async _queryVariable(bbox: BBox, zoom: number, signal?: AbortSignal): Promise<QBTCellData[]> {
    if (!this._variableIndex) throw new Error('Not loaded');

    const [west, south, east, north] = bbox;
    // Find all tiles at given zoom that overlap bbox
    const n = 1 << zoom;
    const xMin = Math.max(0, Math.floor(((west + 180) / 360) * n));
    const xMax = Math.min(n - 1, Math.floor(((east + 180) / 360) * n));
    const latToY = (lat: number) => {
      const rad = (lat * Math.PI) / 180;
      return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
    };
    const yMin = Math.max(0, latToY(north));
    const yMax = Math.min(n - 1, latToY(south));

    const results: QBTCellData[] = [];
    for (let tx = xMin; tx <= xMax; tx++) {
      for (let ty = yMin; ty <= yMax; ty++) {
        const data = await this.getTile(zoom, tx, ty, signal);
        if (data) {
          results.push({
            position: [
              (tx / n) * 360 - 180 + 180 / n,
              // tile center lat approximation
              0,
            ],
            value: data.byteLength,
            chunkIndex: 0,
          });
        }
      }
    }
    return results;
  }

  // ---- Static initializers (called by openQBT) ----

  /** @internal */
  _setVariableIndex(index: Map<bigint, VariableEntry>): void {
    this._variableIndex = index;
  }

  /** @internal */
  _setBitmaskIndex(index: BitmaskIndex, grid: GridParams): void {
    this._bitmaskIndex = index;
    this._grid = grid;
  }

  /** @internal */
  _setColumnarData(columns: Map<string, number[]>, buffer: ArrayBuffer): void {
    this._columns = columns;
    this._buffer = buffer;
  }

  /** @internal */
  _setMetadata(meta: Record<string, any>): void {
    this._metadata = meta;
  }
}

// ===========================================================================
// openQBT — unified loader
// ===========================================================================

/**
 * Open a QBT file. Reads header, determines mode, loads index/data accordingly.
 *
 * @param url - URL or path to .qbt or .qbt.gz file
 * @param onProgress - Progress callback
 * @param signal - AbortSignal for cancellation
 */
export async function openQBT(
  url: string,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<QBT> {
  // 1. Determine if full download or Range Request
  //    .qbt.gz → full download (columnar)
  //    .qbt → Range Request for header first
  const isGzipFile = url.endsWith('.gz');

  let headerBuf: ArrayBuffer;
  let fullBuffer: ArrayBuffer | null = null;

  if (isGzipFile) {
    // Full download + decompress
    onProgress?.('Downloading...');
    const res = await fetch(url, { signal });
    const compressed = await res.arrayBuffer();
    const bytes = new Uint8Array(compressed);
    if (isGzip(bytes)) {
      onProgress?.('Decompressing...');
      fullBuffer = await decompressGzip(bytes);
    } else {
      fullBuffer = compressed;
    }
    headerBuf = fullBuffer;
  } else {
    // Range Request for header
    onProgress?.('Fetching header...');
    const res = await fetch(url, {
      headers: { Range: 'bytes=0-1023' },
      signal,
    });
    headerBuf = await res.arrayBuffer();
  }

  // 2. Parse header
  const header = parseQBTHeader(headerBuf);
  const qbt = new QBT(url, header);

  // 3. Mode-specific initialization
  if (qbt.mode === 'variable') {
    await _initVariable(qbt, url, header, fullBuffer, onProgress, signal);
  } else if (qbt.mode === 'columnar') {
    if (!fullBuffer) {
      // Shouldn't happen for .qbt.gz but handle gracefully
      onProgress?.('Downloading full file...');
      const res = await fetch(url, { signal });
      fullBuffer = await res.arrayBuffer();
    }
    await _initColumnar(qbt, header, fullBuffer, onProgress);
  } else {
    // Fixed row
    await _initFixed(qbt, url, header, onProgress, signal);
  }

  // 4. Parse metadata if present
  if (header.metadataOffset > 0 && header.metadataLength > 0) {
    try {
      let metaBuf: ArrayBuffer;
      if (fullBuffer) {
        metaBuf = fullBuffer.slice(header.metadataOffset, header.metadataOffset + header.metadataLength);
      } else {
        const res = await fetch(url, {
          headers: { Range: `bytes=${header.metadataOffset}-${header.metadataOffset + header.metadataLength - 1}` },
          signal,
        });
        metaBuf = await res.arrayBuffer();
      }
      const metaText = new TextDecoder().decode(metaBuf);
      qbt._setMetadata(JSON.parse(metaText));
    } catch { /* metadata parse failure is non-fatal */ }
  }

  return qbt;
}

async function _initVariable(
  qbt: QBT, url: string, header: QBTHeader,
  fullBuffer: ArrayBuffer | null,
  onProgress?: (msg: string) => void, signal?: AbortSignal,
): Promise<void> {
  let indexCompressed: Uint8Array;

  if (fullBuffer) {
    indexCompressed = new Uint8Array(fullBuffer, header.headerSize, header.bitmaskLength);
  } else {
    // Range Request for index section
    const start = header.headerSize;
    const end = start + header.bitmaskLength - 1;
    onProgress?.('Fetching index...');
    const res = await fetch(url, {
      headers: { Range: `bytes=${start}-${end}` },
      signal,
    });
    const buf = await res.arrayBuffer();
    indexCompressed = new Uint8Array(buf);
  }

  // Decompress
  onProgress?.('Decompressing index...');
  let indexBuf: ArrayBuffer;
  if (isGzip(indexCompressed)) {
    indexBuf = await decompressGzip(indexCompressed);
  } else {
    indexBuf = (indexCompressed.buffer as ArrayBuffer).slice(
      indexCompressed.byteOffset,
      indexCompressed.byteOffset + indexCompressed.byteLength,
    );
  }

  onProgress?.('Building index...');
  const index = deserializeVariableIndex(indexBuf);
  qbt._setVariableIndex(index);
  onProgress?.(`Ready: ${index.size.toLocaleString()} tiles`);
}

async function _initColumnar(
  qbt: QBT, header: QBTHeader, buffer: ArrayBuffer,
  onProgress?: (msg: string) => void,
): Promise<void> {
  // Decompress bitmask section (may be gzip inside the already-decompressed file)
  onProgress?.('Decompressing bitmask...');
  const bitmaskCompressed = new Uint8Array(buffer, header.headerSize, header.bitmaskLength);
  let bitmaskBuf: ArrayBuffer;
  if (isGzip(bitmaskCompressed)) {
    bitmaskBuf = await decompressGzip(bitmaskCompressed);
  } else {
    bitmaskBuf = (bitmaskCompressed.buffer as ArrayBuffer).slice(
      header.headerSize, header.headerSize + header.bitmaskLength,
    );
  }

  onProgress?.('Building index...');
  const index = await deserializeBitmaskIndex(
    bitmaskBuf, header.zoom, onProgress,
    { bitmaskByteLength: bitmaskBuf.byteLength, bufferOffset: 0 },
  );

  // Build grid params
  const grid = _buildGrid(header);

  // Read columnar values
  onProgress?.('Reading values...');
  const columns = readColumnarValues(buffer, header, index.totalLeaves);

  qbt._setBitmaskIndex(index, grid);
  qbt._setColumnarData(columns, buffer);
  onProgress?.(`Ready: ${index.totalLeaves.toLocaleString()} cells`);
}

async function _initFixed(
  qbt: QBT, url: string, header: QBTHeader,
  onProgress?: (msg: string) => void, signal?: AbortSignal,
): Promise<void> {
  // Fetch bitmask via Range Request
  const start = header.headerSize;
  const end = start + header.bitmaskLength - 1;
  onProgress?.(`Fetching bitmask (${(header.bitmaskLength / 1024 / 1024).toFixed(1)} MB)...`);

  const res = await fetch(url, {
    headers: { Range: `bytes=${start}-${end}` },
    signal,
  });
  const compressedBuf = await res.arrayBuffer();

  // Decompress
  const magic = new Uint8Array(compressedBuf, 0, 2);
  let bitmaskBuf: ArrayBuffer;
  if (magic[0] === 0x1f && magic[1] === 0x8b) {
    bitmaskBuf = await decompressGzip(new Uint8Array(compressedBuf));
  } else {
    bitmaskBuf = compressedBuf;
  }

  onProgress?.('Building index...');
  const index = await deserializeBitmaskIndex(
    bitmaskBuf, header.zoom, onProgress,
    { bitmaskByteLength: bitmaskBuf.byteLength, bufferOffset: 0 },
  );

  const grid = _buildGrid(header);
  qbt._setBitmaskIndex(index, grid);
  onProgress?.(`Ready: ${index.totalLeaves.toLocaleString()} cells`);
}

function _buildGrid(header: QBTHeader): GridParams {
  const n = 1 << header.zoom;
  const pixelDeg = header.extentX / n;
  return {
    zoom: header.zoom,
    originLon: header.originX,
    originLat: header.originY,
    pixelDeg,
    rasterCols: n,
    rasterRows: Math.round(header.extentY / pixelDeg),
  };
}
