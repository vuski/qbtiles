/**
 * Decode a quadkey int64 back to center coordinate in a custom CRS.
 * TypeScript port of qbtiles.decode_custom_quadkey.
 *
 * Optimized: converts BigInt to Number once, then uses bitwise ops.
 * Safe for zoom <= 26 (52-bit mantissa covers 2*26 = 52 bits of quadkey data).
 */
export function decodeCustomQuadkey(
  qkInt64: bigint,
  zoom: number,
  originX: number,
  originY: number,
  extent: number,
): [x: number, y: number] {
  const qk = Number(qkInt64 & ((1n << BigInt(zoom * 2)) - 1n));

  let tileX = 0;
  let tileY = 0;
  for (let i = 0; i < zoom; i++) {
    const shift = 2 * (zoom - i - 1);
    const digit = (qk >> shift) & 3;
    tileX = (tileX << 1) | (digit & 1);
    tileY = (tileY << 1) | ((digit >> 1) & 1);
  }

  const tileSize = extent / (1 << zoom);
  const xCenter = originX + tileX * tileSize + tileSize / 2;
  const yCenter = originY + tileY * tileSize + tileSize / 2;

  return [xCenter, yCenter];
}
