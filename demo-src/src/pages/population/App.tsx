import { StrictMode, useState, useEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { MapShell } from '../../components/MapShell';
import { InfoPanel } from '../../components/InfoPanel';
import { ColumnLayer } from '@deck.gl/layers';
import proj4 from 'proj4';
import {
  parseQBTHeader,
  deserializeBitmaskIndex,
  readColumnarValues,
} from 'qbtiles';

const DATA_URL = './korea_pop_100m.qbt.gz';

// EPSG:5179 (Korean 2000 / Central Belt 2010) — pre-create converter once
const EPSG5179 =
  '+proj=tmerc +lat_0=38 +lon_0=127.5 +k=0.9996 +x_0=1000000 +y_0=2000000 +ellps=GRS80 +units=m +no_defs';
const toWGS84 = proj4(EPSG5179, 'EPSG:4326');

type Mode = 'total' | 'male' | 'female';

interface CellData {
  position: [lng: number, lat: number];
  total: number;
  male: number;
  female: number;
}

function getColor(v: number): [number, number, number, number] {
  if (v <= 0) return [0, 0, 0, 0];
  const t = Math.min(Math.log10(v + 1) / 4, 1);
  const r = Math.round(t * 255);
  const g = Math.round((1 - Math.abs(t - 0.5) * 2) * 200);
  const b = Math.round((1 - t) * 255);
  return [r, g, b, 200];
}

function App() {
  const [cells, setCells] = useState<CellData[]>([]);
  const [mode, setMode] = useState<Mode>('total');
  const [tooltip, setTooltip] = useState<{ x: number; y: number; data: CellData } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadStatus, setLoadStatus] = useState('Downloading...');
  const [loadTime, setLoadTime] = useState(0);
  const [fileSize, setFileSize] = useState(0);

  useEffect(() => {
    (async () => {
      const t0 = performance.now();

      setLoadStatus('Downloading...');
      const res = await fetch(DATA_URL);
      const compressed = await res.arrayBuffer();
      const cl = res.headers.get('Content-Length');
      setFileSize(cl ? parseInt(cl) : compressed.byteLength);

      setLoadStatus('Decompressing...');
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

      setLoadStatus('Parsing header...');
      await new Promise((r) => setTimeout(r, 0));
      const header = parseQBTHeader(buffer);

      setLoadStatus('Decompressing bitmask...');
      await new Promise((r) => setTimeout(r, 0));
      const bitmaskCompressed = new Uint8Array(buffer, header.headerSize, header.bitmaskLength);
      let bitmaskBuf: ArrayBuffer;
      if (bitmaskCompressed[0] === 0x1f && bitmaskCompressed[1] === 0x8b) {
        const ds2 = new DecompressionStream('gzip');
        const w2 = ds2.writable.getWriter();
        w2.write(bitmaskCompressed);
        w2.close();
        bitmaskBuf = await new Response(ds2.readable).arrayBuffer();
      } else {
        bitmaskBuf = bitmaskCompressed.buffer.slice(header.headerSize, header.headerSize + header.bitmaskLength);
      }

      setLoadStatus('Building index...');
      await new Promise((r) => setTimeout(r, 0));
      const index = await deserializeBitmaskIndex(
        bitmaskBuf, header.zoom,
        (msg) => setLoadStatus(msg),
        { bitmaskByteLength: bitmaskBuf.byteLength, bufferOffset: 0 },
      );

      setLoadStatus('Reading values...');
      await new Promise((r) => setTimeout(r, 0));
      const columns = readColumnarValues(buffer, header, index.totalLeaves);
      const totals = columns.get('total')!;
      const males = columns.get('male')!;
      const females = columns.get('female')!;

      // BFS expand bitmask to get quadkeys for coordinate conversion
      setLoadStatus('Converting coordinates...');
      await new Promise((r) => setTimeout(r, 0));

      // Walk the tree to get row/col for each leaf, then convert to WGS84
      const { nibbles, childStart } = index;
      const result: CellData[] = [];
      const CHUNK = 50000;
      let leafIdx = 0;

      // Iterative BFS to recover (row, col) for each leaf
      const leafCoords: [number, number][] = new Array(index.totalLeaves); // [row, col]

      // DFS to enumerate leaves in order
      function dfs(nodeIdx: number, row: number, col: number, zoom: number) {
        const mask = nibbles[nodeIdx];
        const firstChild = childStart[nodeIdx];
        let ord = 0;
        for (let i = 0; i < 4; i++) {
          if (!(mask & (8 >> i))) continue;
          const childRow = (row << 1) | ((i >> 1) & 1);
          const childCol = (col << 1) | (i & 1);
          const ci = firstChild + ord;
          ord++;
          if (ci < nibbles.length && nibbles[ci] !== undefined && popcount4(nibbles[ci]) > 0) {
            dfs(ci, childRow, childCol, zoom + 1);
          } else {
            leafCoords[leafIdx++] = [childRow, childCol];
          }
        }
      }

      function popcount4(n: number): number {
        return ((n >> 3) & 1) + ((n >> 2) & 1) + ((n >> 1) & 1) + (n & 1);
      }

      dfs(0, 0, 0, 0);

      // Convert leaf (row, col) → custom CRS center → WGS84
      const originX = header.originX;
      const originY = header.originY;
      const extent = header.extentX;
      const zoom = header.zoom;
      const tileSize = extent / (1 << zoom);

      for (let start = 0; start < index.totalLeaves; start += CHUNK) {
        const end = Math.min(start + CHUNK, index.totalLeaves);
        if (start > 0) {
          setLoadStatus(`Converting coords ${start.toLocaleString()} / ${index.totalLeaves.toLocaleString()}...`);
          await new Promise((r) => setTimeout(r, 0));
        }
        for (let i = start; i < end; i++) {
          const [row, col] = leafCoords[i];
          const cx = originX + col * tileSize + tileSize / 2;
          const cy = originY + row * tileSize + tileSize / 2;
          const [lng, lat] = toWGS84.forward([cx, cy]);
          result.push({
            position: [lng, lat],
            total: totals[i],
            male: males[i],
            female: females[i],
          });
        }
      }

      setCells(result);
      setLoadTime(performance.now() - t0);
      setLoading(false);
    })();
  }, []);

  const layers = useMemo(() => {
    if (cells.length === 0) return [];

    return [
      new ColumnLayer<CellData>({
        id: 'population-columns',
        data: cells,
        getPosition: (d) => d.position,
        getElevation: (d) => {
          const v = mode === 'total' ? d.total : mode === 'male' ? d.male : d.female;
          return v * 3;
        },
        getFillColor: (d) => {
          const v = mode === 'total' ? d.total : mode === 'male' ? d.male : d.female;
          return getColor(v);
        },
        diskResolution: 4,
        radius: 50,
        extruded: true,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 180],
        onHover: (info: any) => {
          if (info.object) {
            setTooltip({ x: info.x, y: info.y, data: info.object });
          } else {
            setTooltip(null);
          }
        },
        updateTriggers: {
          getElevation: mode,
          getFillColor: mode,
        },
      }),
    ];
  }, [cells, mode]);

  const fmt = (n: number) =>
    n >= 1024 * 1024
      ? `${(n / 1024 / 1024).toFixed(1)} MB`
      : n >= 1024
        ? `${(n / 1024).toFixed(1)} KB`
        : `${n} B`;

  const btnStyle = (m: Mode): React.CSSProperties => ({
    padding: '4px 12px',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 13,
    backgroundColor: mode === m ? '#4a90d9' : '#555',
    color: '#fff',
  });

  return (
    <MapShell
      initialViewState={{
        longitude: 127.5,
        latitude: 36,
        zoom: 7,
        pitch: 45,
        bearing: -15,
      }}
      layers={layers}
    >
      <InfoPanel title="Population 100m Grid">
        {loading ? (
          <p style={{ margin: '8px 0 0' }}>{loadStatus}</p>
        ) : (
          <div style={{ margin: '8px 0 0', fontSize: 13 }}>
            <div>Cells: {cells.length.toLocaleString()}</div>
            <div>File: {fmt(fileSize)}</div>
            <div>Per cell: {cells.length > 0 ? (fileSize / cells.length).toFixed(2) : '-'} Byte (coords + 3 values)</div>
            <div>Load: {(loadTime / 1000).toFixed(1)}s</div>
            <div style={{ marginTop: 8, display: 'flex', gap: 4 }}>
              <button style={btnStyle('total')} onClick={() => setMode('total')}>
                Total
              </button>
              <button style={btnStyle('male')} onClick={() => setMode('male')}>
                Male
              </button>
              <button style={btnStyle('female')} onClick={() => setMode('female')}>
                Female
              </button>
            </div>
          </div>
        )}
      </InfoPanel>
      {tooltip && (
        <div
          style={{
            position: 'absolute',
            left: tooltip.x + 12,
            top: tooltip.y + 12,
            background: 'rgba(0,0,0,0.85)',
            color: '#fff',
            padding: '6px 10px',
            borderRadius: 4,
            fontSize: 13,
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          <div>Total: {tooltip.data.total.toLocaleString()}</div>
          <div>Male: {tooltip.data.male.toLocaleString()}</div>
          <div>Female: {tooltip.data.female.toLocaleString()}</div>
        </div>
      )}
    </MapShell>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
