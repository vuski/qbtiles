/**
 * QBT v1.0 header parser.
 */

// Type codes
export const TYPE_UINT8 = 1;
export const TYPE_INT16 = 2;
export const TYPE_UINT16 = 3;
export const TYPE_INT32 = 4;
export const TYPE_UINT32 = 5;
export const TYPE_FLOAT32 = 6;
export const TYPE_FLOAT64 = 7;
export const TYPE_INT64 = 8;
export const TYPE_UINT64 = 9;
export const TYPE_VARINT = 10;

export const TYPE_SIZE: Record<number, number> = {
  [TYPE_UINT8]: 1, [TYPE_INT16]: 2, [TYPE_UINT16]: 2,
  [TYPE_INT32]: 4, [TYPE_UINT32]: 4, [TYPE_FLOAT32]: 4,
  [TYPE_FLOAT64]: 8, [TYPE_INT64]: 8, [TYPE_UINT64]: 8,
};

export interface QBTFieldDescriptor {
  type: number;
  offset: number;
  name: string;
}

export interface QBTHeader {
  magic: string;
  version: number;
  headerSize: number;
  flags: number;
  isFixed: boolean;
  isColumnar: boolean;
  zoom: number;
  crs: number;
  originX: number;
  originY: number;
  extentX: number;
  extentY: number;
  bitmaskLength: number;
  valuesOffset: number;
  valuesLength: number;
  metadataOffset: number;
  metadataLength: number;
  entrySize: number;
  fieldCount: number;
  indexHash: string;
  fields: QBTFieldDescriptor[];
}

/**
 * Parse the first 128+ bytes of a QBT file into a header object.
 * @param buffer - Raw (decompressed) QBT file buffer.
 */
export function parseQBTHeader(buffer: ArrayBuffer): QBTHeader {
  const view = new DataView(buffer);

  const magic = String.fromCharCode(
    view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3),
  );
  if (magic !== 'QBT\x01') {
    throw new Error(`Invalid QBT magic: ${magic}`);
  }

  const version = view.getUint16(4, true);
  const headerSize = view.getUint16(6, true);
  const flags = view.getUint32(8, true);
  const isFixed = !!(flags & 0x1);
  const isColumnar = !!(flags & 0x2);
  const zoom = view.getUint8(12);
  const crs = view.getUint16(14, true);
  const originX = view.getFloat64(16, true);
  const originY = view.getFloat64(24, true);
  const extentX = view.getFloat64(32, true);
  const extentY = view.getFloat64(40, true);

  // uint64 → number (safe for values < 2^53)
  const bitmaskLength = Number(view.getBigUint64(48, true));
  const valuesOffset = Number(view.getBigUint64(56, true));
  const valuesLength = Number(view.getBigUint64(64, true));
  const metadataOffset = Number(view.getBigUint64(72, true));
  const metadataLength = Number(view.getBigUint64(80, true));

  const entrySize = view.getUint32(88, true);
  const fieldCount = view.getUint16(92, true);

  // index_hash: 32 bytes at offset 94
  const hashBytes = new Uint8Array(buffer, 94, 32);
  const indexHash = Array.from(hashBytes).map(b => b.toString(16).padStart(2, '0')).join('');

  // Parse field schema
  const fields: QBTFieldDescriptor[] = [];
  let offset = 128;
  for (let i = 0; i < fieldCount; i++) {
    const type = view.getUint8(offset);
    const foffset = view.getUint8(offset + 1);
    const nameLen = view.getUint16(offset + 2, true);
    const nameBytes = new Uint8Array(buffer, offset + 4, nameLen);
    const name = new TextDecoder().decode(nameBytes);
    fields.push({ type, offset: foffset, name });
    offset += 4 + nameLen;
  }

  return {
    magic, version, headerSize, flags, isFixed, isColumnar,
    zoom, crs, originX, originY, extentX, extentY,
    bitmaskLength, valuesOffset, valuesLength,
    metadataOffset, metadataLength,
    entrySize, fieldCount, indexHash, fields,
  };
}
