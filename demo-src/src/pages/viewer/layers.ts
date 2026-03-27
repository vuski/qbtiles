import { GeoJsonLayer, ScatterplotLayer, TextLayer, PathLayer, LineLayer } from '@deck.gl/layers';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import type { QBT } from 'qbtiles';
import type { BBox4 } from './useQBTFile';

// ── Helpers ─────────────────────────────────────────────────────

function popcount4(n: number): number {
  return ((n >> 3) & 1) + ((n >> 2) & 1) + ((n >> 1) & 1) + (n & 1);
}

// ── BBox rectangle layer ────────────────────────────────────────

export function buildBboxLayer(bbox: BBox4) {
  const [w, s, e, n] = bbox;
  return new GeoJsonLayer({
    id: 'bbox-outline',
    data: {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
        },
      }],
    },
    stroked: true,
    filled: false,
    getLineColor: [255, 165, 0, 200],
    getLineWidth: 2,
    lineWidthUnits: 'pixels',
  });
}

// ── Helpers: Web Mercator tile ↔ lng/lat ────────────────────────

function tile2lng(x: number, z: number): number {
  return (x / (1 << z)) * 360 - 180;
}

function tile2lat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / (1 << z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

function lng2tile(lng: number, z: number): number {
  return Math.floor(((lng + 180) / 360) * (1 << z));
}

function lat2tile(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * (1 << z),
  );
}

// ── Tile grid layer (red lines + z/x/y labels) ─────────────────

interface TileGridData {
  z: number;
  x: number;
  y: number;
  polygon: [number, number][];
  labelPos: [number, number];
}

export function buildGridLayers(qbt: QBT, mapZoom: number, viewBbox: BBox4) {
  const h = qbt.header;
  const [vw, vs, ve, vn] = viewBbox;
  const useWebMercator = h.crs === 4326 || h.crs === 3857;
  const MAX_TILES = 200;

  // Find the level where each tile is at least ~60px on screen
  // At mapZoom z, the world is 256 * 2^z pixels wide
  // A tile at level L covers 360 / 2^L degrees
  // Its screen width ≈ (360 / 2^L) / (360 / 2^z) * 256 = 256 * 2^(z-L) pixels
  // We want 256 * 2^(z-L) >= 60, so L <= z + log2(256/60) ≈ z + 2.1
  // But also cap at file zoom
  const level = Math.min(Math.max(Math.floor(mapZoom) - 2, 0), h.zoom);

  const tiles: TileGridData[] = [];

  if (useWebMercator) {
    const minX = Math.max(0, lng2tile(vw, level));
    const maxX = Math.min((1 << level) - 1, lng2tile(ve, level));
    const minY = Math.max(0, lat2tile(vn, level));
    const maxY = Math.min((1 << level) - 1, lat2tile(vs, level));
    if ((maxX - minX + 1) * (maxY - minY + 1) > MAX_TILES) return [];

    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        const w = tile2lng(x, level);
        const e = tile2lng(x + 1, level);
        const n = tile2lat(y, level);
        const s = tile2lat(y + 1, level);
        tiles.push({
          z: level, x, y,
          polygon: [[w, n], [e, n], [e, s], [w, s], [w, n]],
          labelPos: [w, n],
        });
      }
    }
  } else {
    const cellsPerSide = 1 << level;
    const tileSizeX = h.extentX / cellsPerSide;
    const tileSizeY = h.extentY / cellsPerSide;
    let minCol = 0, maxCol = cellsPerSide - 1, minRow = 0, maxRow = cellsPerSide - 1;
    try {
      const [nw_x, nw_y] = qbt.fromWGS84(vw, vn);
      const [se_x, se_y] = qbt.fromWGS84(ve, vs);
      minCol = Math.max(0, Math.floor((Math.min(nw_x, se_x) - h.originX) / tileSizeX));
      maxCol = Math.min(cellsPerSide - 1, Math.ceil((Math.max(nw_x, se_x) - h.originX) / tileSizeX));
      minRow = Math.max(0, Math.floor((Math.min(nw_y, se_y) - h.originY) / tileSizeY));
      maxRow = Math.min(cellsPerSide - 1, Math.ceil((Math.max(nw_y, se_y) - h.originY) / tileSizeY));
    } catch { /* fallback */ }
    if ((maxCol - minCol + 1) * (maxRow - minRow + 1) > MAX_TILES) return [];

    for (let col = minCol; col <= maxCol; col++) {
      for (let row = minRow; row <= maxRow; row++) {
        const cx0 = h.originX + col * tileSizeX;
        const cx1 = cx0 + tileSizeX;
        const cy0 = h.originY + row * tileSizeY;
        const cy1 = cy0 + tileSizeY;
        try {
          const sw = qbt.toWGS84(cx0, cy0);
          const ne = qbt.toWGS84(cx1, cy1);
          tiles.push({
            z: level, x: col, y: row,
            polygon: [[sw[0], ne[1]], [ne[0], ne[1]], [ne[0], sw[1]], [sw[0], sw[1]], [sw[0], ne[1]]],
            labelPos: [sw[0], ne[1]],
          });
        } catch { /* skip */ }
      }
    }
  }

  console.log(`Grid: level=${level}, tiles=${tiles.length}`);
  if (tiles.length === 0) return [];

  const pathLayer = new PathLayer<TileGridData>({
    id: 'grid-lines',
    data: tiles,
    getPath: (d) => d.polygon,
    getColor: [255, 60, 60, 160],
    getWidth: 1,
    widthUnits: 'pixels' as const,
  });

  const labelLayer = new TextLayer<TileGridData>({
    id: 'grid-labels',
    data: tiles,
    getPosition: (d) => d.labelPos,
    getText: (d) => `${d.z}/${d.x}/${d.y}`,
    getSize: 11,
    getColor: [255, 60, 60, 200],
    getTextAnchor: 'start' as const,
    getAlignmentBaseline: 'top' as const,
    fontFamily: 'monospace',
    billboard: true,
  });

  return [pathLayer, labelLayer];
}

// ── Node count labels (subtreeLeaves at intermediate zoom) ──────

interface NodeInfo {
  position: [number, number];
  label: string;
}

export function getNodesAtLevel(qbt: QBT, targetLevel: number, viewBbox?: BBox4): NodeInfo[] {
  const index = (qbt as any)._bitmaskIndex;
  if (!index) return [];

  const { nibbles, childStart, subtreeLeaves } = index;
  const h = qbt.header;
  const cellSize = h.extentX / (1 << targetLevel);
  const isYDown = h.crs === 4326 || h.crs === 3857;
  const result: NodeInfo[] = [];

  // Compute viewport row/col range at targetLevel for pruning
  let vMinRow = 0, vMaxRow = (1 << targetLevel) - 1;
  let vMinCol = 0, vMaxCol = (1 << targetLevel) - 1;
  if (viewBbox) {
    try {
      const [vx0, vy0] = qbt.fromWGS84(viewBbox[0], viewBbox[3]); // NW
      const [vx1, vy1] = qbt.fromWGS84(viewBbox[2], viewBbox[1]); // SE
      vMinCol = Math.max(0, Math.floor((Math.min(vx0, vx1) - h.originX) / cellSize) - 1);
      vMaxCol = Math.min((1 << targetLevel) - 1, Math.ceil((Math.max(vx0, vx1) - h.originX) / cellSize) + 1);
      if (isYDown) {
        vMinRow = Math.max(0, Math.floor((h.originY - Math.max(vy0, vy1)) / cellSize) - 1);
        vMaxRow = Math.min((1 << targetLevel) - 1, Math.ceil((h.originY - Math.min(vy0, vy1)) / cellSize) + 1);
      } else {
        vMinRow = Math.max(0, Math.floor((Math.min(vy0, vy1) - h.originY) / cellSize) - 1);
        vMaxRow = Math.min((1 << targetLevel) - 1, Math.ceil((Math.max(vy0, vy1) - h.originY) / cellSize) + 1);
      }
    } catch { /* fallback: no pruning */ }
  }

  let queue: { idx: number; row: number; col: number; level: number }[] = [
    { idx: 0, row: 0, col: 0, level: 0 },
  ];

  while (queue.length > 0) {
    const next: typeof queue = [];
    for (const { idx, row, col, level } of queue) {
      // Prune: check if this node's subtree overlaps viewport
      const nodeSize = 1 << (targetLevel - level);
      const nodeMinRow = row * nodeSize;
      const nodeMaxRow = nodeMinRow + nodeSize - 1;
      const nodeMinCol = col * nodeSize;
      const nodeMaxCol = nodeMinCol + nodeSize - 1;
      if (nodeMaxRow < vMinRow || nodeMinRow > vMaxRow || nodeMaxCol < vMinCol || nodeMinCol > vMaxCol) continue;

      if (level === targetLevel) {
        const leaves = subtreeLeaves[idx];
        if (leaves > 0) {
          const cx = h.originX + (col + 0.5) * cellSize;
          const cy = isYDown
            ? h.originY - (row + 0.5) * cellSize
            : h.originY + (row + 0.5) * cellSize;
          try {
            const [lng, lat] = qbt.toWGS84(cx, cy);
            result.push({ position: [lng, lat], label: leaves.toLocaleString() });
          } catch { /* skip */ }
        }
        continue;
      }

      const mask = nibbles[idx];
      if (!mask) continue;
      const first = childStart[idx];
      let ord = 0;
      for (let i = 0; i < 4; i++) {
        if (!(mask & (8 >> i))) continue;
        const ci = first + ord; ord++;
        if (ci < nibbles.length) {
          next.push({ idx: ci, row: (row << 1) | ((i >> 1) & 1), col: (col << 1) | (i & 1), level: level + 1 });
        }
      }
    }
    queue = next;
  }

  return result;
}

export function buildNodeCountLayer(nodes: NodeInfo[]) {
  return new TextLayer<NodeInfo>({
    id: 'node-counts',
    data: nodes,
    getPosition: (d) => d.position,
    getText: (d) => d.label,
    getSize: 14,
    getColor: [50, 50, 50, 220],
    getTextAnchor: 'middle',
    getAlignmentBaseline: 'center',
    fontFamily: 'monospace',
    fontWeight: 'bold',
    outlineWidth: 3,
    outlineColor: [255, 255, 255, 200],
    billboard: true,
  });
}

// ── Scatterplot for grid data (fixed/columnar) ──────────────────

interface CellPoint {
  position: [number, number];
  value: number;
}

export function buildLeafCells(qbt: QBT): CellPoint[] {
  const index = (qbt as any)._bitmaskIndex;
  if (!index) return [];

  const { nibbles, childStart } = index;
  const h = qbt.header;
  const tileSize = h.extentX / (1 << h.zoom);
  const isYDown = h.crs === 4326 || h.crs === 3857;

  // Get first column values
  let values: number[] | null = null;
  if (qbt.columns) {
    const firstCol = qbt.columns.entries().next().value;
    if (firstCol) values = firstCol[1];
  }

  const cells: CellPoint[] = [];
  let leafIdx = 0;

  // Iterative DFS using explicit stack to avoid stack overflow on large trees
  const stack: { nodeIdx: number; row: number; col: number; childBit: number }[] = [
    { nodeIdx: 0, row: 0, col: 0, childBit: 0 },
  ];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const mask = nibbles[frame.nodeIdx];
    const first = childStart[frame.nodeIdx];

    // Find next set bit from childBit
    let found = false;
    while (frame.childBit < 4) {
      const i = frame.childBit;
      frame.childBit++;
      if (!(mask & (8 >> i))) continue;

      // Count ordinal (how many bits set before i)
      let ord = 0;
      for (let j = 0; j < i; j++) {
        if (mask & (8 >> j)) ord++;
      }

      const childRow = (frame.row << 1) | ((i >> 1) & 1);
      const childCol = (frame.col << 1) | (i & 1);
      const ci = first + ord;

      if (ci < nibbles.length && popcount4(nibbles[ci]) > 0) {
        // Internal node — push onto stack
        stack.push({ nodeIdx: ci, row: childRow, col: childCol, childBit: 0 });
        found = true;
        break;
      } else {
        // Leaf node
        const cx = h.originX + childCol * tileSize + tileSize / 2;
        const cy = isYDown
          ? h.originY - childRow * tileSize - tileSize / 2
          : h.originY + childRow * tileSize + tileSize / 2;
        try {
          const [lng, lat] = qbt.toWGS84(cx, cy);
          cells.push({
            position: [lng, lat],
            value: values ? values[leafIdx] : leafIdx,
          });
        } catch { /* skip */ }
        leafIdx++;
      }
    }

    if (!found) {
      stack.pop();
    }
  }

  return cells;
}

function valueToColor(value: number, minVal: number, maxVal: number): [number, number, number, number] {
  // Log scale for better distribution visibility
  const logMin = Math.log1p(Math.max(minVal, 0));
  const logMax = Math.log1p(Math.max(maxVal, 1));
  const logRange = logMax - logMin || 1;
  const t = Math.min(Math.max((Math.log1p(Math.max(value, 0)) - logMin) / logRange, 0), 1);

  // Blue → Cyan → Yellow → Red
  let r: number, g: number, b: number;
  if (t < 0.33) {
    const s = t / 0.33;
    r = 30; g = Math.round(60 + s * 180); b = Math.round(200 - s * 100);
  } else if (t < 0.66) {
    const s = (t - 0.33) / 0.33;
    r = Math.round(s * 240); g = Math.round(240 - s * 40); b = Math.round(100 - s * 80);
  } else {
    const s = (t - 0.66) / 0.34;
    r = 240; g = Math.round(200 - s * 180); b = Math.round(20);
  }
  return [r, g, b, 210];
}

export function buildScatterLayer(cells: CellPoint[], minVal: number, maxVal: number) {
  return new ScatterplotLayer<CellPoint>({
    id: 'scatter-cells',
    data: cells,
    getPosition: (d) => d.position,
    getFillColor: (d) => valueToColor(d.value, minVal, maxVal),
    getRadius: 2,
    radiusUnits: 'pixels',
    radiusMinPixels: 1,
    radiusMaxPixels: 6,
    pickable: true,
  });
}

// ════════════════════════════════════════════════════════════════
// Native CRS functions (for OrthographicView, no WGS84 conversion)
// ════════════════════════════════════════════════════════════════

export function buildLeafCellsNative(qbt: QBT, fieldName?: string): CellPoint[] {
  const index = (qbt as any)._bitmaskIndex;
  if (!index) return [];

  const { nibbles, childStart } = index;
  const h = qbt.header;
  const tileSize = h.extentX / (1 << h.zoom);

  let values: number[] | null = null;
  if (qbt.columns) {
    if (fieldName && qbt.columns.has(fieldName)) {
      values = qbt.columns.get(fieldName)!;
    } else {
      const firstCol = qbt.columns.entries().next().value;
      if (firstCol) values = firstCol[1];
    }
  }

  const cells: CellPoint[] = [];
  let leafIdx = 0;

  const stack: { nodeIdx: number; row: number; col: number; childBit: number }[] = [
    { nodeIdx: 0, row: 0, col: 0, childBit: 0 },
  ];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const mask = nibbles[frame.nodeIdx];
    const first = childStart[frame.nodeIdx];
    let found = false;

    while (frame.childBit < 4) {
      const i = frame.childBit;
      frame.childBit++;
      if (!(mask & (8 >> i))) continue;
      let ord = 0;
      for (let j = 0; j < i; j++) { if (mask & (8 >> j)) ord++; }
      const childRow = (frame.row << 1) | ((i >> 1) & 1);
      const childCol = (frame.col << 1) | (i & 1);
      const ci = first + ord;

      if (ci < nibbles.length && popcount4(nibbles[ci]) > 0) {
        stack.push({ nodeIdx: ci, row: childRow, col: childCol, childBit: 0 });
        found = true;
        break;
      } else {
        // Native CRS: position directly
        const cx = h.originX + childCol * tileSize + tileSize / 2;
        const cy = h.originY + childRow * tileSize + tileSize / 2;
        cells.push({
          position: [cx, cy],
          value: values ? values[leafIdx] : leafIdx,
        });
        leafIdx++;
      }
    }
    if (!found) stack.pop();
  }

  return cells;
}

export function buildScatterLayerNative(cells: CellPoint[], minVal: number, maxVal: number, qbt: QBT) {
  const range = maxVal - minVal || 1;
  const tileSize = qbt.header.extentX / (1 << qbt.header.zoom);

  return new ScatterplotLayer<CellPoint>({
    id: 'scatter-native',
    data: cells,
    coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
    getPosition: (d) => d.position,
    getFillColor: (d) => valueToColor(d.value, minVal, maxVal),
    getRadius: tileSize / 2,
    radiusUnits: 'common' as const,
    pickable: true,
  });
}

export function getNodesAtLevelNative(qbt: QBT, targetLevel: number): NodeInfo[] {
  const index = (qbt as any)._bitmaskIndex;
  if (!index) return [];

  const { nibbles, childStart, subtreeLeaves } = index;
  const h = qbt.header;
  const cellSize = h.extentX / (1 << targetLevel);
  const result: NodeInfo[] = [];

  let queue: { idx: number; row: number; col: number; level: number }[] = [
    { idx: 0, row: 0, col: 0, level: 0 },
  ];

  while (queue.length > 0) {
    const next: typeof queue = [];
    for (const { idx, row, col, level } of queue) {
      if (level === targetLevel) {
        const leaves = subtreeLeaves[idx];
        if (leaves > 0) {
          const cx = h.originX + (col + 0.5) * cellSize;
          const cy = h.originY + (row + 0.5) * cellSize;
          result.push({ position: [cx, cy], label: leaves.toLocaleString() });
        }
        continue;
      }
      const mask = nibbles[idx];
      if (!mask) continue;
      const first = childStart[idx];
      let ord = 0;
      for (let i = 0; i < 4; i++) {
        if (!(mask & (8 >> i))) continue;
        const ci = first + ord; ord++;
        if (ci < nibbles.length) {
          next.push({ idx: ci, row: (row << 1) | ((i >> 1) & 1), col: (col << 1) | (i & 1), level: level + 1 });
        }
      }
    }
    queue = next;
  }
  return result;
}

export function buildNodeCountLayerNative(nodes: NodeInfo[]) {
  return new TextLayer<NodeInfo>({
    id: 'node-counts-native',
    data: nodes,
    coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
    getPosition: (d) => d.position,
    getText: (d) => d.label,
    getSize: 14,
    getColor: [50, 50, 50, 220],
    getTextAnchor: 'middle' as const,
    getAlignmentBaseline: 'center' as const,
    fontFamily: 'monospace',
    fontWeight: 'bold',
    outlineWidth: 3,
    outlineColor: [255, 255, 255, 200],
  });
}

export function buildGridLinesNative(qbt: QBT) {
  const h = qbt.header;
  // Draw extent border
  const x0 = h.originX, x1 = h.originX + h.extentX;
  const y0 = h.originY, y1 = h.originY + h.extentY;

  return [
    new PathLayer({
      id: 'extent-border-native',
      data: [{ path: [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]] }],
      coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      getPath: (d: any) => d.path,
      getColor: [255, 165, 0, 200],
      getWidth: 2,
      widthUnits: 'pixels' as const,
    }),
  ];
}
