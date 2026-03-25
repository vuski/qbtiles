import { useState, useEffect, useRef, useCallback } from 'react';
import { type BBox, splitAntimeridian, WORLD_POP_GRID } from '../../lib/geo-constants';
import {
  type BitmaskIndex,
  type QBTCellData,
  type QBTChunk,
  type QBTHeader,
  queryBbox,
  mergeRanges,
  fetchRanges,
  queryResultToCells,
  queryResultToChunks,
  loadQBT,
} from 'qbtiles';

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

  const indexRef = useRef<BitmaskIndex | null>(null);
  const headerRef = useRef<QBTHeader | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // Guard against StrictMode double-mount
    if (indexRef.current) {
      setState((s) => ({
        ...s,
        indexLoading: false,
        indexProgress: `Ready: ${indexRef.current!.totalLeaves.toLocaleString()} cells`,
      }));
      return;
    }

    (async () => {
      try {
        const { header, index, indexBytes } = await loadQBT(qbtUrl, (msg) =>
          setState((s) => ({ ...s, indexProgress: msg })),
        );
        indexRef.current = index;
        headerRef.current = header;
        setState((s) => ({
          ...s,
          indexLoading: false,
          indexBytes,
          indexProgress: `Ready: ${index.totalLeaves.toLocaleString()} cells`,
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
      const index = indexRef.current;
      const header = headerRef.current;
      if (!index || !header) return undefined;

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
        const bboxes = splitAntimeridian(bbox);
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
