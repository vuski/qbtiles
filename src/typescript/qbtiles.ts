/**
 * QBTiles - Quadtree Bitmask Tile Index (Client Reader)
 *
 * gzip 해제된 바이너리 인덱스 버퍼를 역직렬화하여
 * Map<bigint, QBTilesIndex>로 변환한다.
 */

export interface QBTilesIndex {
  quadkey_int: bigint;
  z: number;
  x: number;
  y: number;
  offset: number;
  length: number;
  vertex_offset: number;
  vertex_length: number;
}

// === 1. Bitmask 확장
function expandQuadkeyInt64(parent: bigint, bitmask: number): bigint[] {
  const children: bigint[] = [];
  for (let i = 0; i < 4; i++) {
    if (bitmask & (1 << (3 - i))) {
      const child = (parent << 2n) | BigInt(i);
      children.push(child);
    }
  }
  return children;
}

// === 2. int64 → z/x/y 변환
export function quadkeyInt64ToZXY(qint64: bigint): {
  z: number;
  x: number;
  y: number;
} {
  let x = 0;
  let y = 0;
  let z = 0;
  let foundPrefix = false;

  for (let shift = 62n; shift >= 0n; shift -= 2n) {
    const digit = (qint64 >> shift) & 0b11n;
    if (!foundPrefix) {
      if (digit === 0b11n) foundPrefix = true;
      continue;
    }
    x = (x << 1) | Number(digit & 1n);
    y = (y << 1) | Number((digit >> 1n) & 1n);
    z += 1;
  }

  return { z, x, y };
}

// === 3. z/x/y → int64 변환
export function tileToQuadkeyInt64(z: number, x: number, y: number): bigint {
  let quadkeyInt64 = 3n;
  for (let i = z - 1; i >= 0; i--) {
    const digit = ((BigInt(y >> i) & 1n) << 1n) | (BigInt(x >> i) & 1n);
    quadkeyInt64 = (quadkeyInt64 << 2n) | digit;
  }
  return quadkeyInt64;
}

// === 4. varint 읽기
function readVarint(view: DataView, offsetRef: { offset: number }): number {
  let result = 0;
  let shift = 0;
  let byte = 0;
  let offset = offsetRef.offset;

  while (true) {
    byte = view.getUint8(offset++);
    result |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) break;
    shift += 7;
  }

  offsetRef.offset = offset;
  return result;
}

// === 5. 인덱스 역직렬화
export function deserializeQuadtreeIndex(
  buffer: ArrayBuffer,
): Map<bigint, QBTilesIndex> {
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

  // 쿼드키 확장 (정수 기반)
  const quadkeys: bigint[] = [3n];
  let queue: bigint[] = [3n];

  let i = 0;

  while (i < bitmasks.length) {
    const nextQueue: bigint[] = [];
    for (const parent of queue) {
      if (i >= bitmasks.length) break;
      const children = expandQuadkeyInt64(parent, bitmasks[i]);
      quadkeys.push(...children);
      nextQueue.push(...children);
      i += 1;
    }
    queue = nextQueue;
  }

  // 열 방향 varint 읽기: run_lengths → lengths → offsets
  const run_lengths: number[] = [];
  const lengths: number[] = [];

  for (let i = 0; i < quadkeys.length; i++) {
    run_lengths.push(readVarint(view, offsetRef));
  }

  for (let i = 0; i < quadkeys.length; i++) {
    lengths.push(readVarint(view, offsetRef));
  }

  const offsets: number[] = [];
  for (let i = 0; i < quadkeys.length; i++) {
    const encoded = readVarint(view, offsetRef);
    if (i > 0 && encoded === 0) {
      offsets.push(offsets[i - 1] + lengths[i - 1]);
    } else {
      offsets.push(encoded - 1);
    }
  }

  // 엔트리 맵 구성
  const entryMap: Map<bigint, QBTilesIndex> = new Map();
  let vertex_offset = 0;
  for (let i = 0; i < quadkeys.length; i++) {
    if (lengths[i] === 0) continue;
    const qkInt = quadkeys[i];
    const { z, x, y } = quadkeyInt64ToZXY(qkInt);
    entryMap.set(qkInt, {
      quadkey_int: qkInt,
      z,
      x,
      y,
      offset: offsets[i],
      length: lengths[i],
      vertex_offset,
      vertex_length: run_lengths[i],
    });
    vertex_offset += run_lengths[i];
  }

  return entryMap;
}
