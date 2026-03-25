import { useState, useEffect, useRef, useCallback } from 'react';
import { type BBox, splitAntimeridian } from '../../lib/geo-constants';
import {
  type BitmaskIndex,
  type QBTCellData,
  type QBTChunk,
  deserializeBitmaskIndex,
  queryBbox,
  mergeRanges,
  fetchRanges,
  queryResultToCells,
  queryResultToChunks,
} from '../../lib/bitmask-index';

export interface QBTStats {
  requests: number;
  bytes: number;
  cells: number;
  timeMs: number;
  estimatedRequests: number; // without cache
  estimatedBytes: number;    // without cache
  cachedCells: number;
}

export interface QBTQueryState {
  indexLoading: boolean;
  indexProgress: string;
  indexBytes: number; // bitmask download size
  querying: boolean;
  error: string | null;
  results: QBTCellData[] | null;
  chunks: QBTChunk[];
  stats: QBTStats | null;
}

export function useQBTilesQuery(bitmaskUrl: string, valuesUrl: string) {
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
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setState((s) => ({ ...s, indexProgress: 'Downloading index...' }));
        const res = await fetch(bitmaskUrl);
        const compressed = await res.arrayBuffer();
        const indexBytes = compressed.byteLength;
        const sizeStr = (indexBytes / 1024 / 1024).toFixed(1);

        setState((s) => ({ ...s, indexBytes, indexProgress: `Decompressing (${sizeStr} MB)...` }));
        const bytes = new Uint8Array(compressed);
        let buffer: ArrayBuffer;
        if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
          const ds = new DecompressionStream('gzip');
          const writer = ds.writable.getWriter();
          writer.write(bytes);
          writer.close();
          buffer = await new Response(ds.readable).arrayBuffer();
        } else {
          buffer = compressed;
        }

        const index = await deserializeBitmaskIndex(buffer, (msg) =>
          setState((s) => ({ ...s, indexProgress: msg })),
        );
        indexRef.current = index;
        setState((s) => ({
          ...s,
          indexLoading: false,
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
  }, [bitmaskUrl]);

  const query = useCallback(
    async (bbox: BBox, onProgress?: (p: { request: number; bytes: number }) => void): Promise<{ bytes: number } | undefined> => {
      const index = indexRef.current;
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
        // Split across antimeridian if needed
        const bboxes = splitAntimeridian(bbox);
        let allLeafIndices: number[] = [];
        let allRows: number[] = [];
        let allCols: number[] = [];
        for (const b of bboxes) {
          const r = queryBbox(index, b);
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

        const ranges = mergeRanges(result.leafIndices);

        const { values, totalBytes, requestCount, estimatedBytes, estimatedRequests, cachedCells } =
          await fetchRanges(valuesUrl, ranges, ac.signal, onProgress);

        const cells = queryResultToCells(result, values, ranges);
        const chunks = queryResultToChunks(result, ranges);
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
    [valuesUrl],
  );

  return { state, query };
}
