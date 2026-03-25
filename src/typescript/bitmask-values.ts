/**
 * Deserialize QBTiles bitmask + adaptive bit-width values.
 * TypeScript port of popu_utils.read_bitmask_values.
 */

export interface BitmaskEntry {
  quadkeyInt: bigint;
  a: number;
  b: number;
  c: number;
}

function expandQuadkey(parent: bigint, bitmask: number): bigint[] {
  const children: bigint[] = [];
  for (let i = 0; i < 4; i++) {
    if (bitmask & (1 << (3 - i))) {
      children.push((parent << 2n) | BigInt(i));
    }
  }
  return children;
}

/**
 * Deserialize a gzip-decompressed bitmask+values buffer.
 *
 * File format:
 *   [4 bytes: bitmask byte length]
 *   [bitmask section: two 4-bit values per byte, BFS order]
 *   [values section: adaptive bit-width encoded triples]
 *
 * Adaptive encoding per entry:
 *   0b0000xxxx → (0, 0, 0) — 1 byte
 *   0b0001aaaa bbbbcccc → (a, b, c) all < 16 — 2 bytes
 *   0b0010xxxx aa bb cc → (a, b, c) all < 256 — 4 bytes
 *   0b0011xxxx aabb ccdd eeff → (a, b, c) as uint16 LE — 7 bytes
 */
export function deserializeBitmaskValues(
  buffer: ArrayBuffer,
  leafZoom: number,
): BitmaskEntry[] {
  const view = new DataView(buffer);
  let offset = 0;

  const bitmaskLen = view.getUint32(offset);
  offset += 4;

  const bitmasks: number[] = [];
  for (let i = 0; i < bitmaskLen; i++) {
    const byte = view.getUint8(offset++);
    bitmasks.push(byte >> 4);
    bitmasks.push(byte & 0x0f);
  }
  if (bitmasks.length > 0 && bitmasks[bitmasks.length - 1] === 0) {
    bitmasks.pop();
  }

  const leafQuadkeys: bigint[] = [];
  let queue: bigint[] = [3n];
  let bmIdx = 0;

  while (bmIdx < bitmasks.length) {
    const nextQueue: bigint[] = [];
    for (const parent of queue) {
      if (bmIdx >= bitmasks.length) break;
      const children = expandQuadkey(parent, bitmasks[bmIdx]);
      bmIdx++;

      for (const child of children) {
        let z = 0;
        let tmp = child >> 2n;
        while (tmp > 3n) {
          tmp >>= 2n;
          z++;
        }
        z++;

        if (z === leafZoom) {
          leafQuadkeys.push(child);
        }
      }
      nextQueue.push(...children);
    }
    queue = nextQueue;
  }

  const entries: BitmaskEntry[] = [];
  for (const qk of leafQuadkeys) {
    const head = view.getUint8(offset);
    const prefix = head >> 4;

    let a: number, b: number, c: number;

    if (prefix === 0b0000) {
      a = b = c = 0;
      offset += 1;
    } else if (prefix === 0b0001) {
      a = head & 0x0f;
      const second = view.getUint8(offset + 1);
      b = (second >> 4) & 0x0f;
      c = second & 0x0f;
      offset += 2;
    } else if (prefix === 0b0010) {
      a = view.getUint8(offset + 1);
      b = view.getUint8(offset + 2);
      c = view.getUint8(offset + 3);
      offset += 4;
    } else if (prefix === 0b0011) {
      a = view.getUint16(offset + 1, true);
      b = view.getUint16(offset + 3, true);
      c = view.getUint16(offset + 5, true);
      offset += 7;
    } else {
      throw new Error(`Unknown prefix: ${prefix.toString(2)}`);
    }

    if (a > 0 || b > 0 || c > 0) {
      entries.push({ quadkeyInt: qk, a, b, c });
    }
  }

  return entries;
}
