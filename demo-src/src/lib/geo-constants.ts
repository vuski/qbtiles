/**
 * Global population grid constants (WorldPop 2025, 1km).
 * 43200 cols × 17280 rows, ~0.00833° per pixel, zoom=16 quadtree.
 */

export const ZOOM = 16;
export const GRID_SIZE = 1 << ZOOM; // 65536
export const RASTER_COLS = 43200;
export const RASTER_ROWS = 17280;
export const PIXEL_DEG = 1 / 120; // 360 / 43200
export const ORIGIN_LON = -180;
export const ORIGIN_LAT = 84; // top of raster (lat goes down)

export type BBox = [west: number, south: number, east: number, north: number];

export function lonToCol(lon: number): number {
  return Math.floor((lon - ORIGIN_LON) / PIXEL_DEG);
}

export function latToRow(lat: number): number {
  return Math.floor((ORIGIN_LAT - lat) / PIXEL_DEG);
}

export function colToLon(col: number): number {
  return ORIGIN_LON + col * PIXEL_DEG + PIXEL_DEG / 2;
}

export function rowToLat(row: number): number {
  return ORIGIN_LAT - row * PIXEL_DEG - PIXEL_DEG / 2;
}

export function bboxToRowColRange(bbox: BBox): {
  colMin: number; colMax: number; rowMin: number; rowMax: number;
} {
  return {
    colMin: Math.max(0, lonToCol(bbox[0])),
    colMax: Math.min(RASTER_COLS - 1, lonToCol(bbox[2])),
    rowMin: Math.max(0, latToRow(bbox[3])), // north → smaller row
    rowMax: Math.min(RASTER_ROWS - 1, latToRow(bbox[1])), // south → larger row
  };
}

/**
 * Split a bbox that crosses the antimeridian (lon ±180) into 1 or 2 bboxes.
 * Also clamps latitude to raster extent [-60, 84].
 *
 * If east > 180, it means the box wraps around:
 *   [west, south, east, north] → [west, s, 180, n] + [-180, s, east-360, n]
 * If west < -180:
 *   [west, south, east, north] → [-180, s, east, n] + [west+360, s, 180, n]
 * Otherwise returns the single bbox clamped.
 */
export function splitAntimeridian(bbox: BBox): BBox[] {
  let [w, s, e, n] = bbox;
  // Clamp latitude
  s = Math.max(-60, s);
  n = Math.min(84, n);
  if (s >= n) return [];

  // Normalize: shift entire bbox so west falls within [-180, 180)
  while (w >= 180) { w -= 360; e -= 360; }
  while (w < -180) { w += 360; e += 360; }

  // No wrap needed
  if (w >= -180 && e <= 180) {
    return [[w, s, e, n]];
  }

  // East crosses +180
  if (e > 180) {
    const parts: BBox[] = [];
    if (w < 180) parts.push([Math.max(-180, w), s, 180, n]);
    const wrappedE = e - 360;
    if (wrappedE > -180) parts.push([-180, s, Math.min(180, wrappedE), n]);
    return parts;
  }

  // West crosses -180
  if (w < -180) {
    const parts: BBox[] = [];
    const wrappedW = w + 360;
    if (wrappedW < 180) parts.push([wrappedW, s, 180, n]);
    if (e > -180) parts.push([-180, s, Math.min(180, e), n]);
    return parts;
  }

  return [[w, s, e, n]];
}
