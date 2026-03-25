/**
 * WorldPop 2025 grid constants + re-exports from qbtiles library.
 */
import {
  type BBox,
  type GridParams,
  splitAntimeridian as _splitAntimeridian,
  bboxToRowColRange as _bboxToRowColRange,
} from 'qbtiles';

export type { BBox, GridParams };

export const ZOOM = 16;
export const GRID_SIZE = 1 << ZOOM;
export const RASTER_COLS = 43200;
export const RASTER_ROWS = 17280;
export const PIXEL_DEG = 1 / 120;
export const ORIGIN_LON = -180;
export const ORIGIN_LAT = 84;

/** WorldPop grid parameters for library functions. */
export const WORLD_POP_GRID: GridParams = {
  zoom: ZOOM,
  originLon: ORIGIN_LON,
  originLat: ORIGIN_LAT,
  pixelDeg: PIXEL_DEG,
  rasterCols: RASTER_COLS,
  rasterRows: RASTER_ROWS,
};

/** Split bbox at antimeridian, clamped to WorldPop lat extent [-60, 84]. */
export function splitAntimeridian(bbox: BBox): BBox[] {
  return _splitAntimeridian(bbox, -60, 84);
}

/** Convert bbox to row/col range for WorldPop grid. */
export function bboxToRowColRange(bbox: BBox) {
  return _bboxToRowColRange(bbox, ORIGIN_LON, ORIGIN_LAT, PIXEL_DEG, RASTER_COLS, RASTER_ROWS);
}
