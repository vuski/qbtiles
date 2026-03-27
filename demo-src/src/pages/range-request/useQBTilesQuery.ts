import { useState, useEffect, useRef, useCallback } from 'react';
import { type BBox, type GridParams } from '../../lib/geo-constants';
import {
  openQBT,
  type QBT,
  type QBTCellData,
  type QBTChunk,
  queryBbox,
  mergeRanges,
  fetchRanges,
  queryResultToCells,
  queryResultToChunks,
  splitAntimeridian,
} from 'qbtiles';

/** Derive grid params from QBT header (no more hardcoding). */
function gridFromHeader(qbt: QBT): GridParams {
  const h = qbt.header;
  const pixelDeg = h.extentX / (1 << h.zoom);
  return {
    zoom: h.zoom,
    originLon: h.originX,
    originLat: h.originY,
    pixelDeg,
    rasterCols: Math.round(h.extentX / pixelDeg),
    rasterRows: Math.round(h.extentY / pixelDeg),
  };
}

export interface QBTStats {
  requests: number;
  bytes: number;
  cells: number;
  timeMs: number;
  estimatedRequests: number;
  estimatedBytes: number;
  cachedCells: number;
}

export interface QBTQueryState {
  indexLoading: boolean;
  indexProgress: string;
  indexBytes: number;
  querying: boolean;
  error: string | null;
  results: QBTCellData[] | null;
  chunks: QBTChunk[];
  stats: QBTStats | null;
}

export function useQBTilesQuery(qbtUrl: string) {
  const [state, setState] = useState<QBTQueryState>({
    indexLoading: true,
    indexProgress: 'Downloading index...',
    indexBytes: 0,
    querying: false,
    error: null,
    results: null,
    chunks: [],
    stats: null,
  });

  const qbtRef = useRef<QBT | null>(null);
  const gridRef = useRef<GridParams | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (qbtRef.current) {
      setState((s) => ({
        ...s,
        indexLoading: false,
        indexProgress: `Ready: ${qbtRef.current!.leafCount.toLocaleString()} cells`,
      }));
      return;
    }

    (async () => {
      try {
        const qbt = await openQBT(qbtUrl, (msg) =>
          setState((s) => ({ ...s, indexProgress: msg })),
        );
        qbtRef.current = qbt;
        gridRef.current = gridFromHeader(qbt);
        setState((s) => ({
          ...s,
          indexLoading: false,
          indexBytes: qbt.header.bitmaskLength,
          indexProgress: `Ready: ${qbt.leafCount.toLocaleString()} cells`,
        }));
      } catch (err: any) {
        setState((s) => ({
          ...s,
          indexLoading: false,
          error: `Index load failed: ${err.message}`,
        }));
      }
    })();
  }, [qbtUrl]);

  const query = useCallback(
    async (bbox: BBox, onProgress?: (p: { request: number; bytes: number }) => void): Promise<{ bytes: number } | undefined> => {
      const qbt = qbtRef.current;
      const grid = gridRef.current;
      if (!qbt || !grid) return undefined;

      // Access internal index and grid for low-level query (demo needs chunks for visualization)
      const index = (qbt as any)._bitmaskIndex;
      const header = qbt.header;
      if (!index) return undefined;

      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      setState((s) => ({
        ...s,
        querying: true,
        error: null,
        results: null,
        chunks: [],
        stats: null,
      }));

      try {
        const t0 = performance.now();
        const bboxes = splitAntimeridian(bbox as any);
        let allLeafIndices: number[] = [];
        let allRows: number[] = [];
        let allCols: number[] = [];
        for (const b of bboxes) {
          const r = queryBbox(index, b, grid);
          allLeafIndices = allLeafIndices.concat(r.leafIndices);
          allRows = allRows.concat(r.rows);
          allCols = allCols.concat(r.cols);
        }
        const result = { leafIndices: allLeafIndices, rows: allRows, cols: allCols };

        if (result.leafIndices.length === 0) {
          setState((s) => ({
            ...s,
            querying: false,
            results: [],
            chunks: [],
            stats: { requests: 0, bytes: 0, cells: 0, timeMs: performance.now() - t0, estimatedRequests: 0, estimatedBytes: 0, cachedCells: 0 },
          }));
          return { bytes: 0 };
        }

        const ranges = mergeRanges(result.leafIndices, 256, header.entrySize);

        const { values, totalBytes, requestCount, estimatedBytes, estimatedRequests, cachedCells } =
          await fetchRanges(qbtUrl, ranges, ac.signal, onProgress, header.valuesOffset);

        const cells = queryResultToCells(result, values, ranges, grid);
        const chunks = queryResultToChunks(result, ranges, grid);
        const elapsed = performance.now() - t0;

        setState((s) => ({
          ...s,
          querying: false,
          results: cells,
          chunks,
          stats: {
            requests: requestCount,
            bytes: totalBytes,
            cells: cells.length,
            timeMs: elapsed,
            estimatedRequests,
            estimatedBytes,
            cachedCells,
          },
        }));

        return { bytes: totalBytes };
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          setState((s) => ({
            ...s,
            querying: false,
            error: `Query failed: ${err.message}`,
          }));
        }
      }
    },
    [qbtUrl],
  );

  return { state, query };
}
