/**
 * Shared types and spatial utilities for QBTiles.
 */

/** Geographic bounding box [west, south, east, north] in degrees. */
export type BBox = [west: number, south: number, east: number, north: number];

/**
 * Grid parameters for a regular spatial grid encoded as a quadtree.
 */
export interface GridParams {
  zoom: number;
  originLon: number;
  originLat: number;
  pixelDeg: number;
  rasterCols: number;
  rasterRows: number;
}

/** Convert longitude to grid column index. */
export function lonToCol(lon: number, originLon: number, pixelDeg: number): number {
  return Math.floor((lon - originLon) / pixelDeg);
}

/** Convert latitude to grid row index. */
export function latToRow(lat: number, originLat: number, pixelDeg: number): number {
  return Math.floor((originLat - lat) / pixelDeg);
}

/** Convert grid column to center longitude. */
export function colToLon(col: number, originLon: number, pixelDeg: number): number {
  return originLon + col * pixelDeg + pixelDeg / 2;
}

/** Convert grid row to center latitude. */
export function rowToLat(row: number, originLat: number, pixelDeg: number): number {
  return originLat - row * pixelDeg - pixelDeg / 2;
}

/** Convert bbox to row/col range within a grid. */
export function bboxToRowColRange(
  bbox: BBox,
  originLon: number,
  originLat: number,
  pixelDeg: number,
  rasterCols: number,
  rasterRows: number,
): { colMin: number; colMax: number; rowMin: number; rowMax: number } {
  return {
    colMin: Math.max(0, lonToCol(bbox[0], originLon, pixelDeg)),
    colMax: Math.min(rasterCols - 1, lonToCol(bbox[2], originLon, pixelDeg)),
    rowMin: Math.max(0, latToRow(bbox[3], originLat, pixelDeg)),
    rowMax: Math.min(rasterRows - 1, latToRow(bbox[1], originLat, pixelDeg)),
  };
}

/**
 * Split a bbox that crosses the antimeridian (lon ±180) into 1 or 2 bboxes.
 * Also clamps latitude to the given extent.
 */
export function splitAntimeridian(
  bbox: BBox,
  latMin = -90,
  latMax = 90,
): BBox[] {
  let [w, s, e, n] = bbox;
  s = Math.max(latMin, s);
  n = Math.min(latMax, n);
  if (s >= n) return [];

  // Normalize west to [-180, 180)
  while (w >= 180) { w -= 360; e -= 360; }
  while (w < -180) { w += 360; e += 360; }

  if (w >= -180 && e <= 180) {
    return [[w, s, e, n]];
  }

  if (e > 180) {
    const parts: BBox[] = [];
    if (w < 180) parts.push([Math.max(-180, w), s, 180, n]);
    const wrappedE = e - 360;
    if (wrappedE > -180) parts.push([-180, s, Math.min(180, wrappedE), n]);
    return parts;
  }

  if (w < -180) {
    const parts: BBox[] = [];
    const wrappedW = w + 360;
    if (wrappedW < 180) parts.push([wrappedW, s, 180, n]);
    if (e > -180) parts.push([-180, s, Math.min(180, e), n]);
    return parts;
  }

  return [[w, s, e, n]];
}
