import { useState, useEffect, useRef, useCallback } from 'react';
import { type BBox } from '../../lib/geo-constants';
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

// Re-export grid params for COG comparison
export const WORLD_POP_GRID = {
  zoom: 16,
  originLon: -180,
  originLat: 84,
  pixelDeg: 360 / 43200,
  rasterCols: 43200,
  rasterRows: 17280,
};

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
      if (!qbt) return undefined;

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
          const r = queryBbox(index, b, WORLD_POP_GRID);
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

        const cells = queryResultToCells(result, values, ranges, WORLD_POP_GRID);
        const chunks = queryResultToChunks(result, ranges, WORLD_POP_GRID);
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
