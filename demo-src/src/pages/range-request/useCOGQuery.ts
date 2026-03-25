import { useState, useRef, useCallback } from 'react';
import { type BBox, splitAntimeridian } from '../../lib/geo-constants';
import { queryCOG, type COGCellData, type COGChunk, type COGStats, type COGTrafficPoint } from '../../lib/cog-query';

export interface COGQueryState {
  querying: boolean;
  error: string | null;
  results: COGCellData[] | null;
  chunks: COGChunk[];
  stats: COGStats | null;
  trafficHistory: COGTrafficPoint[];
}

export function useCOGQuery(cogUrl: string) {
  const [state, setState] = useState<COGQueryState>({
    querying: false,
    error: null,
    results: null,
    chunks: [],
    stats: null,
    trafficHistory: [],
  });
  const abortRef = useRef<AbortController | null>(null);

  const query = useCallback(
    async (bbox: BBox, onProgress?: (p: { request: number; bytes: number }) => void): Promise<{ bytes: number } | undefined> => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      setState({
        querying: true,
        error: null,
        results: null,
        chunks: [],
        stats: null,
        trafficHistory: [],
      });

      try {
        const bboxes = splitAntimeridian(bbox);
        if (bboxes.length === 1) {
          const result = await queryCOG(cogUrl, bboxes[0], ac.signal, onProgress);
          setState((s) => ({
            ...s,
            querying: false,
            results: result.cells,
            chunks: result.chunks,
            stats: result.stats,
          }));
          return { bytes: result.stats.bytes };
        }
        // Multiple bboxes (antimeridian crossing) — query each separately
        // queryCOG monkey-patches globalThis.fetch, so we must await sequentially
        // and ensure fetch is restored between calls
        let allCells: COGCellData[] = [];
        let allChunks: COGChunk[] = [];
        let totalRequests = 0, totalBytes = 0, totalCells = 0, totalTiles = 0, totalCached = 0;
        let totalTime = 0;
        for (const b of bboxes) {
          try {
            const result = await queryCOG(cogUrl, b, ac.signal, onProgress);
            allCells = allCells.concat(result.cells);
            allChunks = allChunks.concat(result.chunks);
            totalRequests += result.stats.requests;
            totalBytes += result.stats.bytes;
            totalCells += result.stats.cells;
            totalTiles += result.stats.tileCount;
            totalCached += result.stats.cachedTiles;
            totalTime += result.stats.timeMs;
          } catch (err: any) {
            if (err.name === 'AbortError') throw err;
            console.warn('COG query for split bbox failed:', b, err);
          }
        }
        setState((s) => ({
          ...s,
          querying: false,
          results: allCells,
          chunks: allChunks,
          stats: { requests: totalRequests, bytes: totalBytes, cells: totalCells, timeMs: totalTime, tileCount: totalTiles, cachedTiles: totalCached },
        }));
        return { bytes: totalBytes };
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          setState((s) => ({
            ...s,
            querying: false,
            error: `COG query failed: ${err.message}`,
          }));
        }
      }
    },
    [cogUrl],
  );

  return { state, query };
}
