import { useState, useCallback } from 'react';
import { openQBT, type QBT } from 'qbtiles';

export type BBox4 = [west: number, south: number, east: number, north: number];

export interface DerivedGrid {
  zoom: number;
  originLon: number;
  originLat: number;
  pixelDeg: number;
  rasterCols: number;
  rasterRows: number;
}

export function useQBTFile() {
  const [qbt, setQbt] = useState<QBT | null>(null);
  const [fileName, setFileName] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadStatus, setLoadStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [bbox, setBbox] = useState<BBox4 | null>(null);
  const [showBasemap, setShowBasemap] = useState(true);
  const [derivedGrid, setDerivedGrid] = useState<DerivedGrid | null>(null);

  const loadFile = useCallback(async (buffer: ArrayBuffer, name: string) => {
    setLoading(true);
    setError(null);
    setFileName(name);
    setLoadStatus('Parsing file...');

    try {
      let finalBuffer = buffer;
      if (name.endsWith('.gz')) {
        setLoadStatus('Decompressing gzip...');
        const ds = new DecompressionStream('gzip');
        const writer = ds.writable.getWriter();
        writer.write(new Uint8Array(buffer));
        writer.close();
        finalBuffer = await new Response(ds.readable).arrayBuffer();
      }

      const blob = new Blob([finalBuffer]);
      const url = URL.createObjectURL(blob);
      const loaded = await openQBT(url, (msg) => setLoadStatus(msg));

      const h = loaded.header;
      const basemap = h.crs === 4326 || h.crs === 3857;
      setShowBasemap(basemap);

      let computedBbox: BBox4;

      // Try metadata.data_bounds first (fastest, all modes)
      const meta = loaded.metadata;
      if (meta?.data_bounds) {
        const db = meta.data_bounds;
        computedBbox = [db.west, Math.max(db.south, -85), db.east, Math.min(db.north, 85)];

        // Derive grid params for fixed/columnar query
        if (loaded.mode !== 'variable') {
          const n = 1 << h.zoom;
          const pixelDeg = h.extentX / n;
          const grid: DerivedGrid = {
            zoom: h.zoom,
            originLon: h.originX,
            originLat: h.originY,
            pixelDeg,
            rasterCols: n,
            rasterRows: Math.round(h.extentY / pixelDeg),
          };
          setDerivedGrid(grid);
          console.log('Derived grid from metadata:', grid);
        }
      } else if (loaded.mode === 'variable') {
        // Fallback: compute bbox from deepest-zoom tiles in variable index
        const varIndex = (loaded as any)._variableIndex as Map<bigint, any> | undefined;
        if (varIndex && varIndex.size > 0) {
          let maxZoomInIndex = 0;
          for (const qk of varIndex.keys()) {
            let temp = qk; let z = 0;
            while (temp > 3n) { temp >>= 2n; z++; }
            if (z > maxZoomInIndex) maxZoomInIndex = z;
          }
          let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
          for (const qk of varIndex.keys()) {
            const bits: number[] = [];
            let temp = qk;
            while (temp > 3n) { bits.push(Number(temp & 3n)); temp >>= 2n; }
            const z = bits.length;
            if (z < maxZoomInIndex) continue;
            let x = 0, y = 0;
            for (let i = bits.length - 1; i >= 0; i--) {
              x = (x << 1) | (bits[i] & 1);
              y = (y << 1) | ((bits[i] >> 1) & 1);
            }
            const w = (x / (1 << z)) * 360 - 180;
            const e = ((x + 1) / (1 << z)) * 360 - 180;
            const nRad = Math.PI - (2 * Math.PI * y) / (1 << z);
            const sRad = Math.PI - (2 * Math.PI * (y + 1)) / (1 << z);
            const n = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(nRad) - Math.exp(-nRad)));
            const s = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(sRad) - Math.exp(-sRad)));
            if (w < minX) minX = w;
            if (e > maxX) maxX = e;
            if (s < minY) minY = s;
            if (n > maxY) maxY = n;
          }
          computedBbox = [minX, Math.max(minY, -85), maxX, Math.min(maxY, 85)];
        } else {
          computedBbox = [-180, -85, 180, 85];
        }
      } else {
        // Fixed/columnar: compute bbox + derive grid params from bitmask
        const index = (loaded as any)._bitmaskIndex;
        if (index) {
          const { nibbles, childStart } = index;
          let minRow = Infinity, maxRow = -Infinity, minCol = Infinity, maxCol = -Infinity;

          const stack: { idx: number; row: number; col: number }[] = [{ idx: 0, row: 0, col: 0 }];
          while (stack.length > 0) {
            const { idx, row, col } = stack.pop()!;
            const mask = nibbles[idx];
            const first = childStart[idx];
            let ord = 0;
            for (let i = 0; i < 4; i++) {
              if (!(mask & (8 >> i))) continue;
              const cr = (row << 1) | ((i >> 1) & 1);
              const cc = (col << 1) | (i & 1);
              const ci = first + ord; ord++;
              const cm = ci < nibbles.length ? nibbles[ci] : 0;
              const pc = ((cm >> 3) & 1) + ((cm >> 2) & 1) + ((cm >> 1) & 1) + (cm & 1);
              if (ci < nibbles.length && pc > 0) {
                stack.push({ idx: ci, row: cr, col: cc });
              } else {
                if (cr < minRow) minRow = cr;
                if (cr > maxRow) maxRow = cr;
                if (cc < minCol) minCol = cc;
                if (cc > maxCol) maxCol = cc;
              }
            }
          }

          if (minRow <= maxRow) {
            // Derive actual grid params from leaf range
            const rasterCols = maxCol + 1;
            const rasterRows = maxRow + 1;
            const pixelDeg = h.extentX / rasterCols;
            const isYDown = h.crs === 4326 || h.crs === 3857;

            const grid: DerivedGrid = {
              zoom: h.zoom,
              originLon: h.originX,
              originLat: h.originY,
              pixelDeg,
              rasterCols,
              rasterRows,
            };
            setDerivedGrid(grid);
            console.log('Derived grid:', grid);

            const x0 = h.originX + minCol * pixelDeg;
            const x1 = h.originX + (maxCol + 1) * pixelDeg;
            let y0: number, y1: number;
            if (isYDown) {
              y0 = h.originY - (maxRow + 1) * pixelDeg;
              y1 = h.originY - minRow * pixelDeg;
            } else {
              y0 = h.originY + minRow * pixelDeg;
              y1 = h.originY + (maxRow + 1) * pixelDeg;
            }
            try {
              const sw = loaded.toWGS84(x0, y0);
              const ne = loaded.toWGS84(x1, y1);
              computedBbox = [
                Math.min(sw[0], ne[0]),
                Math.max(Math.min(sw[1], ne[1]), -85),
                Math.max(sw[0], ne[0]),
                Math.min(Math.max(sw[1], ne[1]), 85),
              ];
            } catch {
              computedBbox = [-180, -85, 180, 85];
            }
          } else {
            computedBbox = [-180, -85, 180, 85];
          }
        } else {
          computedBbox = [-180, -85, 180, 85];
        }
      }
      setBbox(computedBbox);
      setQbt(loaded);
      setLoading(false);
    } catch (e: any) {
      setError(e.message || String(e));
      setLoading(false);
    }
  }, []);

  return { qbt, fileName, loading, loadStatus, error, bbox, showBasemap, derivedGrid, loadFile };
}
