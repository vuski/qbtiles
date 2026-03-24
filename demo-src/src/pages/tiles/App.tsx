import { StrictMode, useState, useCallback, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import maplibregl from 'maplibre-gl';
import { MapShell } from '../../components/MapShell';
import { InfoPanel } from '../../components/InfoPanel';
import {
  deserializeQuadtreeIndex,
  tileToQuadkeyInt64,
  type QBTilesIndex,
} from 'qbtiles';

const INDEX_URL = './korea_tiles.idx.gz';
const DATA_URL = './korea_tiles.data';

interface Stats {
  indexSize: number;
  entries: number;
  tilesLoaded: number;
  bytesRequested: number;
}

function App() {
  const [stats, setStats] = useState<Stats>({
    indexSize: 0,
    entries: 0,
    tilesLoaded: 0,
    bytesRequested: 0,
  });
  const [zoom, setZoom] = useState(7);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const indexRef = useRef<Map<bigint, QBTilesIndex> | null>(null);

  // Load index on mount
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(INDEX_URL);
        const raw = await res.arrayBuffer();
        setStats((s) => ({ ...s, indexSize: raw.byteLength }));

        // Decompress gzip if needed
        const bytes = new Uint8Array(raw);
        let buffer: ArrayBuffer;
        if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
          const ds = new DecompressionStream('gzip');
          const writer = ds.writable.getWriter();
          writer.write(bytes);
          writer.close();
          buffer = await new Response(ds.readable).arrayBuffer();
        } else {
          buffer = raw;
        }

        const index = deserializeQuadtreeIndex(buffer);
        indexRef.current = index;
        setStats((s) => ({ ...s, entries: index.size }));
        setLoading(false);
      } catch (e) {
        setError(String(e));
        setLoading(false);
      }
    })();
  }, []);

  const handleMapLoad = useCallback(
    (map: maplibregl.Map) => {
      const tryAdd = () => {
        const index = indexRef.current;
        if (!index) {
          setTimeout(tryAdd, 200);
          return;
        }

        // Register custom protocol for MVT tiles
        (maplibregl as any).addProtocol(
          'qbtiles',
          async (params: any, abortController: AbortController) => {
            // params.url: "qbtiles:///7/109/49"
            const parts = params.url.replace('qbtiles://', '').split('/').filter(Boolean);
            const [z, x, y] = parts.map(Number);
            const qk = tileToQuadkeyInt64(z, x, y);
            const entry = index.get(qk);

            if (!entry) {
              return { data: new ArrayBuffer(0) };
            }

            setStats((s) => ({
              ...s,
              tilesLoaded: s.tilesLoaded + 1,
              bytesRequested: s.bytesRequested + entry.length,
            }));

            const res = await fetch(DATA_URL, {
              headers: {
                Range: `bytes=${entry.offset}-${entry.offset + entry.length - 1}`,
              },
              signal: abortController.signal,
            });

            let data = await res.arrayBuffer();

            // Decompress gzip MVT
            const bytes = new Uint8Array(data);
            if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
              const ds = new DecompressionStream('gzip');
              const writer = ds.writable.getWriter();
              writer.write(bytes);
              writer.close();
              data = await new Response(ds.readable).arrayBuffer();
            }

            return { data };
          },
        );

        map.addSource('qbtiles-vector', {
          type: 'vector',
          tiles: ['qbtiles:///{z}/{x}/{y}'],
          minzoom: 0,
          maxzoom: 14,
          promoteId: 'featureId',
        });

        // Sido (province) fill + line
        map.addLayer({
          id: 'qbtiles-sido-fill',
          type: 'fill',
          source: 'qbtiles-vector',
          'source-layer': 'sido',
          paint: {
            'fill-color': '#4a90d9',
            'fill-opacity': 0.15,
          },
        });
        map.addLayer({
          id: 'qbtiles-sido-line',
          type: 'line',
          source: 'qbtiles-vector',
          'source-layer': 'sido_line',
          paint: { 'line-color': '#1e3a5f', 'line-width': 2 },
        });

        // Sgg (district)
        map.addLayer({
          id: 'qbtiles-sgg-line',
          type: 'line',
          source: 'qbtiles-vector',
          'source-layer': 'sgg_line',
          paint: { 'line-color': '#2563eb', 'line-width': 1 },
        });

        // Emd (subdistrict)
        map.addLayer({
          id: 'qbtiles-emd-line',
          type: 'line',
          source: 'qbtiles-vector',
          'source-layer': 'emd_line',
          paint: { 'line-color': '#60a5fa', 'line-width': 0.5 },
        });

        // Tile boundary grid
        map.addSource('tile-grid', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });

        map.addLayer({
          id: 'tile-grid-line',
          type: 'line',
          source: 'tile-grid',
          paint: {
            'line-color': '#ff4444',
            'line-width': 1,
            'line-opacity': 0.5,
          },
        });

        const updateGrid = () => {
          const z = Math.floor(map.getZoom());
          setZoom(z);
          const bounds = map.getBounds();
          const n = Math.pow(2, z);
          const features: GeoJSON.Feature[] = [];

          const xMin = Math.max(
            0,
            Math.floor(((bounds.getWest() + 180) / 360) * n),
          );
          const xMax = Math.min(
            n - 1,
            Math.floor(((bounds.getEast() + 180) / 360) * n),
          );

          const latToTileY = (lat: number) => {
            const rad = (lat * Math.PI) / 180;
            return Math.floor(
              ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) /
                2) *
                n,
            );
          };

          const yMin = Math.max(0, latToTileY(bounds.getNorth()));
          const yMax = Math.min(n - 1, latToTileY(bounds.getSouth()));

          const tileToLng = (x: number) => (x / n) * 360 - 180;
          const tileToLat = (y: number) => {
            const nPI = Math.PI - (2 * Math.PI * y) / n;
            return (
              (180 / Math.PI) *
              Math.atan(0.5 * (Math.exp(nPI) - Math.exp(-nPI)))
            );
          };

          for (let tx = xMin; tx <= xMax; tx++) {
            for (let ty = yMin; ty <= yMax; ty++) {
              const w = tileToLng(tx);
              const e = tileToLng(tx + 1);
              const n_ = tileToLat(ty);
              const s = tileToLat(ty + 1);
              features.push({
                type: 'Feature',
                properties: {},
                geometry: {
                  type: 'Polygon',
                  coordinates: [
                    [[w, n_], [e, n_], [e, s], [w, s], [w, n_]],
                  ],
                },
              });
            }
          }

          (map.getSource('tile-grid') as maplibregl.GeoJSONSource).setData({
            type: 'FeatureCollection',
            features,
          });
        };

        map.on('moveend', updateGrid);
        updateGrid();
      };

      tryAdd();
    },
    [],
  );

  const fmt = (n: number) =>
    n >= 1024 * 1024
      ? `${(n / 1024 / 1024).toFixed(1)} MB`
      : n >= 1024
        ? `${(n / 1024).toFixed(1)} KB`
        : `${n} B`;

  return (
    <MapShell
      initialViewState={{ longitude: 127.5, latitude: 36, zoom: 7 }}
      onMapLoad={handleMapLoad}
    >
      <InfoPanel title="Tile Map Viewer">
        {loading ? (
          <p style={{ margin: '8px 0 0' }}>Loading index...</p>
        ) : error ? (
          <p style={{ margin: '8px 0 0', color: '#ff6b6b' }}>{error}</p>
        ) : (
          <div style={{ margin: '8px 0 0', fontSize: 13 }}>
            <div>Zoom: {zoom}</div>
            <div>Index: {fmt(stats.indexSize)} (gzip)</div>
            <div>Entries: {stats.entries.toLocaleString()}</div>
            <div>Tiles loaded: {stats.tilesLoaded}</div>
            <div>Bytes requested: {fmt(stats.bytesRequested)}</div>
          </div>
        )}
      </InfoPanel>
    </MapShell>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
