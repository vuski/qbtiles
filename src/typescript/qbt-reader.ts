/**
 * QBT v1.0 high-level reader.
 * - loadQBT: header fetch → hash-based index cache → bitmask deserialize
 * - readColumnarValues: columnar decoder for varint + fixed types
 */
import { parseQBTHeader, TYPE_VARINT, TYPE_SIZE, type QBTHeader } from './qbt-header';
import { deserializeBitmaskIndex, type BitmaskIndex } from './bitmask-index';

// ---------------------------------------------------------------------------
// Index cache (keyed by index_hash)
// ---------------------------------------------------------------------------
const indexCache = new Map<string, BitmaskIndex>();

export function clearIndexCache(): void {
  indexCache.clear();
}

// ---------------------------------------------------------------------------
// Load QBT (header + bitmask)
// ---------------------------------------------------------------------------
export interface LoadResult {
  header: QBTHeader;
  index: BitmaskIndex;
  indexBytes: number;
}

/**
 * Load a QBT file: fetch header (128B+), check hash cache, fetch bitmask if needed.
 * Works with both split-file (.qbt with Range Request) and full-file scenarios.
 */
export async function loadQBT(
  url: string,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<LoadResult> {
  // 1. Fetch header (first 1024 bytes to include field schema)
  onProgress?.('Fetching header...');
  const headerRes = await fetch(url, {
    headers: { Range: 'bytes=0-1023' },
    signal,
  });
  const headerBuf = await headerRes.arrayBuffer();
  const header = parseQBTHeader(headerBuf);

  // 2. Check index cache by hash
  const allZero = header.indexHash === '0'.repeat(64);
  if (!allZero && indexCache.has(header.indexHash)) {
    onProgress?.('Index cache hit');
    return { header, index: indexCache.get(header.indexHash)!, indexBytes: 0 };
  }

  // 3. Fetch bitmask section
  const bitmaskStart = header.headerSize;
  const bitmaskEnd = bitmaskStart + header.bitmaskLength - 1;
  onProgress?.(`Fetching bitmask (${(header.bitmaskLength / 1024 / 1024).toFixed(1)} MB)...`);

  const bitmaskRes = await fetch(url, {
    headers: { Range: `bytes=${bitmaskStart}-${bitmaskEnd}` },
    signal,
  });
  const indexBytes = parseInt(bitmaskRes.headers.get('content-length') || '0', 10) || header.bitmaskLength;
  const compressedBuf = await bitmaskRes.arrayBuffer();

  // 4. Decompress if gzipped (check magic bytes 0x1f 0x8b)
  const magic = new Uint8Array(compressedBuf, 0, 2);
  let bitmaskBuf: ArrayBuffer;
  if (magic[0] === 0x1f && magic[1] === 0x8b) {
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(new Uint8Array(compressedBuf));
    writer.close();
    bitmaskBuf = await new Response(ds.readable).arrayBuffer();
  } else {
    bitmaskBuf = compressedBuf;
  }

  // 5. Deserialize (no 4B prefix — bitmaskByteLength from decompressed size)
  const index = await deserializeBitmaskIndex(
    bitmaskBuf, header.zoom, onProgress,
    { bitmaskByteLength: bitmaskBuf.byteLength, bufferOffset: 0 },
  );

  // 5. Cache
  if (!allZero) {
    indexCache.set(header.indexHash, index);
  }

  return { header, index, indexBytes };
}

// ---------------------------------------------------------------------------
// Load QBT Variable-entry (tile archive)
// ---------------------------------------------------------------------------
export interface VariableLoadResult {
  header: QBTHeader;
  buffer: ArrayBuffer;  // decompressed index section (bitmask + varints, no 4B prefix)
}

/**
 * Load a variable-entry QBT file: fetch full file → decompress index section.
 * Returns the decompressed buffer for use with deserializeQuadtreeIndex(buffer, { bitmaskByteLength }).
 *
 * Usage:
 *   const { header, buffer } = await loadQBTVariable(url);
 *   const index = deserializeQuadtreeIndex(buffer, { bitmaskByteLength: header.bitmaskByteLength });
 */
export async function loadQBTVariable(
  url: string,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<VariableLoadResult> {
  onProgress?.('Downloading...');
  const res = await fetch(url, { signal });
  const raw = await res.arrayBuffer();

  // Parse header
  const header = parseQBTHeader(raw);

  // Extract index section (gzip-compressed bitmask + varints)
  const indexCompressed = new Uint8Array(raw, header.headerSize, header.bitmaskLength);

  // Decompress
  onProgress?.('Decompressing index...');
  let buffer: ArrayBuffer;
  if (indexCompressed[0] === 0x1f && indexCompressed[1] === 0x8b) {
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(indexCompressed);
    writer.close();
    buffer = await new Response(ds.readable).arrayBuffer();
  } else {
    buffer = indexCompressed.buffer.slice(
      header.headerSize, header.headerSize + header.bitmaskLength
    );
  }

  return { header, buffer };
}

// ---------------------------------------------------------------------------
// Fetch a single tile from a variable-entry archive
// ---------------------------------------------------------------------------

/**
 * Fetch a single tile's data via HTTP Range Request.
 */
export async function fetchTile(
  dataUrl: string,
  entry: { offset: number; length: number },
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const res = await fetch(dataUrl, {
    headers: { Range: `bytes=${entry.offset}-${entry.offset + entry.length - 1}` },
    signal,
  });
  return res.arrayBuffer();
}

// ---------------------------------------------------------------------------
// Columnar value reader
// ---------------------------------------------------------------------------

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

/**
 * Read columnar values from a decompressed QBT buffer.
 * @returns Map of field name → number array (length = leafCount)
 */
export function readColumnarValues(
  buffer: ArrayBuffer,
  header: QBTHeader,
  leafCount: number,
): Map<string, number[]> {
  const view = new DataView(buffer);
  const offsetRef = { offset: header.valuesOffset };
  const result = new Map<string, number[]>();

  for (const field of header.fields) {
    const values: number[] = new Array(leafCount);
    if (field.type === TYPE_VARINT) {
      for (let i = 0; i < leafCount; i++) {
        values[i] = readVarint(view, offsetRef);
      }
    } else {
      const size = TYPE_SIZE[field.type];
      if (!size) throw new Error(`Unknown type code: ${field.type}`);
      for (let i = 0; i < leafCount; i++) {
        switch (field.type) {
          case 1: values[i] = view.getUint8(offsetRef.offset); break;
          case 2: values[i] = view.getInt16(offsetRef.offset, true); break;
          case 3: values[i] = view.getUint16(offsetRef.offset, true); break;
          case 4: values[i] = view.getInt32(offsetRef.offset, true); break;
          case 5: values[i] = view.getUint32(offsetRef.offset, true); break;
          case 6: values[i] = view.getFloat32(offsetRef.offset, true); break;
          case 7: values[i] = view.getFloat64(offsetRef.offset, true); break;
        }
        offsetRef.offset += size;
      }
    }
    result.set(field.name, values);
  }

  return result;
}
