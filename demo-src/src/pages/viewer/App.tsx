import { StrictMode, useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import maplibregl from 'maplibre-gl';
import Map from 'react-map-gl/maplibre';
import type { MapRef, ViewStateChangeEvent } from 'react-map-gl/maplibre';
import { Deck, OrthographicView } from '@deck.gl/core';
import { DeckGLOverlay } from '../../components/DeckGLOverlay';
import { DropZone } from './DropZone';
import { HeaderPanel } from './HeaderPanel';
import { useQBTFile } from './useQBTFile';
import {
  buildBboxLayer,
  buildGridLayers,
  buildNodeCountLayer,
  buildPreviewLayer,
  buildScatterLayer,
  buildScatterLayerNative,
  buildLeafCellsNative,
  getNodesAtLevel,
  getNodesAtLevelNative,
  buildPreviewLayerNative,
  buildNodeCountLayerNative,
  buildGridLinesNative,
} from './layers';
import type { BBox4, DerivedGrid } from './useQBTFile';
import {
  queryBbox,
  mergeRanges,
  fetchRanges,
  queryResultToCells,
  splitAntimeridian,
} from 'qbtiles';
import 'maplibre-gl/dist/maplibre-gl.css';

const BASEMAP_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
const CELL_VISIBLE_OFFSET = 9; // show cells when mapZoom >= fileZoom - this value
const PREVIEW_ZOOM_AHEAD = 7;  // preview bitmask at mapZoom + this level
const EMPTY_STYLE: maplibregl.StyleSpecification = { version: 8, sources: {}, layers: [] };

interface CellPoint {
  position: [number, number];
  value: number;
}

// ════════════════════════════════════════════════════════════════
// Geo mode (CRS 4326/3857) — MapLibre + deck.gl overlay
// ════════════════════════════════════════════════════════════════

function GeoViewer({ qbt, fileName, bbox, loadFile, derivedGrid }: {
  qbt: any; fileName: string; bbox: BBox4; loadFile: (buf: ArrayBuffer, name: string) => void; derivedGrid: DerivedGrid | null;
}) {
  const [viewState, setViewState] = useState({
    longitude: 0, latitude: 20, zoom: 2, pitch: 0, bearing: 0,
  });
  const [mapZoom, setMapZoom] = useState(2);
  const [viewBbox, setViewBbox] = useState<BBox4>([-180, -90, 180, 90]);
  const mapRef = useRef<MapRef>(null);
  const [leafCells, setLeafCells] = useState<CellPoint[]>([]);
  const [cellStats, setCellStats] = useState({ min: 0, max: 1 });
  const protocolRegistered = useRef(false);
  const [zoomMessage, setZoomMessage] = useState<string | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const handleMapLoad = useCallback(() => setMapLoaded(true), []);
  const [activeField, setActiveField] = useState<string>(qbt.header.fields[0]?.name ?? '');

  // Fit map to bbox (after map is loaded)
  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    mapRef.current.getMap().fitBounds(
      [[bbox[0], Math.max(bbox[1], -85)], [bbox[2], Math.min(bbox[3], 85)]],
      { padding: 40, duration: 1000 },
    );
  }, [bbox, mapLoaded]);

  // Query visible cells for fixed/columnar mode using low-level functions
  // (same pattern as range-request demo)
  const queryAbort = useRef<AbortController | null>(null);
  const queryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    console.log(`query check: mode=${qbt.mode}, derivedGrid=${!!derivedGrid}, mapZoom=${mapZoom}, threshold=${qbt.header.zoom - CELL_VISIBLE_OFFSET}`);
    if (qbt.mode === 'variable' || !derivedGrid) { setLeafCells([]); return; }
    if (Math.floor(mapZoom) < qbt.header.zoom - CELL_VISIBLE_OFFSET) { setLeafCells([]); return; }

    if (queryTimer.current) clearTimeout(queryTimer.current);
    queryTimer.current = setTimeout(() => {
      queryAbort.current?.abort();
      const ac = new AbortController();
      queryAbort.current = ac;

      (async () => {
        try {
          const index = (qbt as any)._bitmaskIndex;
          if (!index) return;

          const t0 = performance.now();
          const bboxes = splitAntimeridian(viewBbox as any);
          let allLeafIndices: number[] = [];
          let allRows: number[] = [];
          let allCols: number[] = [];
          for (const b of bboxes) {
            const r = queryBbox(index, b, derivedGrid);
            allLeafIndices = allLeafIndices.concat(r.leafIndices);
            allRows = allRows.concat(r.rows);
            allCols = allCols.concat(r.cols);
          }
          const result = { leafIndices: allLeafIndices, rows: allRows, cols: allCols };
          console.log(`queryBbox: ${result.leafIndices.length} leaves, ${(performance.now()-t0).toFixed(1)}ms`);

          if (result.leafIndices.length === 0) { setLeafCells([]); return; }

          let points: CellPoint[];
          if (qbt.header.entrySize === 0) {
            // Bitmask-only: no values to fetch, all cells have value=1
            points = result.leafIndices.map((_, i) => ({
              position: [
                derivedGrid.originLon + result.cols[i] * derivedGrid.pixelDeg + derivedGrid.pixelDeg / 2,
                derivedGrid.originLat - result.rows[i] * derivedGrid.pixelDeg - derivedGrid.pixelDeg / 2,
              ] as [number, number],
              value: 1,
            }));
          } else {
            const ranges = mergeRanges(result.leafIndices, 256, qbt.header.entrySize);
            const { values } = await fetchRanges(
              qbt.url, ranges, ac.signal, undefined, qbt.header.valuesOffset,
            );
            if (ac.signal.aborted) return;

            const cells = queryResultToCells(result, values, ranges, derivedGrid);
            points = cells.map((c: any) => ({
              position: c.position,
              value: c.values?.[activeField] ?? c.value ?? 0,
            }));
          }
          if (points.length > 0) {
            let min = Infinity, max = -Infinity;
            for (const p of points) { if (p.value < min) min = p.value; if (p.value > max) max = p.value; }
            setCellStats({ min, max });
          }
          console.log(`query result: ${points.length} cells, ${(performance.now()-t0).toFixed(1)}ms`);
          setLeafCells(points);
        } catch (e: any) {
          if (e.name !== 'AbortError') console.error('Query error:', e);
        }
      })();
    }, 300);

    return () => { if (queryTimer.current) clearTimeout(queryTimer.current); };
  }, [qbt, mapZoom, viewBbox, derivedGrid, activeField]);

  // Variable mode: register protocol + add MapLibre layers
  useEffect(() => {
    if (qbt.mode !== 'variable' || !mapLoaded || !mapRef.current) return;
    const map = mapRef.current.getMap();

    // Use library's addProtocol (now handles gzip decompression internally)
    qbt.addProtocol(maplibregl, 'qbtviewer');

    const addSourceAndLayers = async () => {
      // Wait for style to load
      if (!map.isStyleLoaded()) {
        await new Promise<void>((resolve) => map.once('styledata', () => resolve()));
      }

      try {
        map.getStyle().layers?.forEach((l) => { if (l.id.startsWith('qbt-')) map.removeLayer(l.id); });
      } catch { /* ok */ }
      if (map.getSource('qbt-tiles')) map.removeSource('qbt-tiles');
      map.addSource('qbt-tiles', { type: 'vector', tiles: ['qbtviewer:///{z}/{x}/{y}'], maxzoom: qbt.header.zoom });

      // Get MVT layer names from metadata (written by build(folder=))
      const layerNames: string[] = [];
      const meta = qbt.metadata;
      if (meta?.vector_layers) {
        for (const vl of meta.vector_layers) {
          if (vl.id && !layerNames.includes(vl.id)) layerNames.push(vl.id);
        }
      }
      console.log('MVT layers from metadata:', layerNames);
      if (layerNames.length === 0) return;
      const colors = ['#4a90d9', '#d94a7a', '#4ad99a', '#d9b44a', '#9a4ad9'];
      layerNames.forEach((name, i) => {
        const c = colors[i % colors.length];
        map.addLayer({ id: `qbt-fill-${i}`, type: 'fill', source: 'qbt-tiles', 'source-layer': name, paint: { 'fill-color': c, 'fill-opacity': 0.3 } });
        map.addLayer({ id: `qbt-line-${i}`, type: 'line', source: 'qbt-tiles', 'source-layer': name, paint: { 'line-color': c, 'line-width': 1 } });
      });
    };
    addSourceAndLayers();
  }, [qbt, mapLoaded]);

  const moveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleMove = useCallback((evt: ViewStateChangeEvent) => {
    setViewState(evt.viewState);
    // Debounce zoom/bbox updates to avoid per-frame layer rebuilds
    if (moveTimer.current) clearTimeout(moveTimer.current);
    moveTimer.current = setTimeout(() => {
      setMapZoom(evt.viewState.zoom);
      if (mapRef.current) {
        const b = mapRef.current.getMap().getBounds();
        setViewBbox([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
      }
    }, 200);
  }, []);

  useEffect(() => {
    if (qbt.mode === 'variable') { setZoomMessage(null); return; }
    setZoomMessage(Math.floor(mapZoom) < qbt.header.zoom - CELL_VISIBLE_OFFSET
      ? `Zoom in to level ${qbt.header.zoom - CELL_VISIBLE_OFFSET} to see cell data (current: ${Math.floor(mapZoom)})`
      : null);
  }, [qbt, mapZoom]);

  const layers = useMemo(() => {
    const result: any[] = [buildBboxLayer(bbox)];
    const gt0 = performance.now();
    const gridLayers = buildGridLayers(qbt, mapZoom, viewBbox);
    console.log(`buildGridLayers: ${(performance.now()-gt0).toFixed(1)}ms`);
    result.push(...gridLayers);
    if (qbt.mode !== 'variable') {
      const fileZoom = qbt.header.zoom;
      console.log(`Mode: ${qbt.mode}, mapZoom=${mapZoom.toFixed(1)}, fileZoom=${fileZoom}, leafCells=${leafCells.length}`);
      if (Math.floor(mapZoom) < fileZoom - CELL_VISIBLE_OFFSET) {
        const displayLevel = Math.min(Math.floor(mapZoom) + PREVIEW_ZOOM_AHEAD, fileZoom);
        const t0 = performance.now();
        const nodes = getNodesAtLevel(qbt, displayLevel, viewBbox);
        const t1 = performance.now();
        const previewCellDeg = qbt.header.extentX / (1 << displayLevel);
        console.log(`getNodesAtLevel(${displayLevel}): ${nodes.length} nodes, ${(t1-t0).toFixed(1)}ms`);
        result.push(buildPreviewLayer(nodes, previewCellDeg));
      } else if (leafCells.length > 0) {
        const t0 = performance.now();
        result.push(buildScatterLayer(leafCells, cellStats.min, cellStats.max, derivedGrid?.pixelDeg ?? qbt.header.extentX / (1 << qbt.header.zoom)));
        console.log(`buildScatterLayer: ${leafCells.length} cells, ${(performance.now()-t0).toFixed(1)}ms`);
      }
    }
    return result;
  }, [qbt, bbox, mapZoom, viewBbox, leafCells, cellStats]);

  return (
    <>
      <Map ref={mapRef} {...viewState} onMove={handleMove} onLoad={handleMapLoad} mapStyle={BASEMAP_STYLE} style={{ width: '100%', height: '100%' }}>
        <DeckGLOverlay layers={layers} />
      </Map>
      <HeaderPanel qbt={qbt} fileName={fileName} activeField={activeField} onFieldChange={setActiveField} />
      <DropZone onFile={loadFile} hasFile={true} />
      <button onClick={() => mapRef.current?.getMap().fitBounds([[bbox[0], Math.max(bbox[1], -85)], [bbox[2], Math.min(bbox[3], 85)]], { padding: 40, duration: 500 })}
        style={{ position: 'absolute', bottom: 60, right: 12, padding: '6px 14px', background: 'rgba(0,0,0,0.7)', color: '#fff', border: '1px solid #555', borderRadius: 6, cursor: 'pointer', fontSize: 13, zIndex: 10 }}>
        Zoom to extent
      </button>
      {zoomMessage && (
        <div style={{ position: 'absolute', bottom: 60, left: '50%', transform: 'translateX(-50%)', background: 'rgba(0,0,0,0.75)', color: '#fff', padding: '10px 20px', borderRadius: 6, fontSize: 14, zIndex: 10, whiteSpace: 'nowrap' }}>
          {zoomMessage}
        </div>
      )}
    </>
  );
}

// ════════════════════════════════════════════════════════════════
// Ortho mode (custom CRS) — standalone deck.gl with OrthographicView
// ════════════════════════════════════════════════════════════════

function OrthoViewer({ qbt, fileName, loadFile }: {
  qbt: any; fileName: string; loadFile: (buf: ArrayBuffer, name: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const deckRef = useRef<any>(null);
  const [leafCells, setLeafCells] = useState<CellPoint[]>([]);
  const [cellStats, setCellStats] = useState({ min: 0, max: 1 });
  const [activeField, setActiveField] = useState<string>(qbt.header.fields[0]?.name ?? '');

  // Build leaf cells in native CRS coordinates (no WGS84 conversion)
  useEffect(() => {
    const cells = buildLeafCellsNative(qbt, activeField);
    if (cells.length > 0) {
      let min = Infinity, max = -Infinity;
      for (const c of cells) { if (c.value < min) min = c.value; if (c.value > max) max = c.value; }
      setCellStats({ min, max });
    }
    setLeafCells(cells);
  }, [qbt, activeField]);

  // Create standalone Deck instance
  useEffect(() => {
    if (!containerRef.current) return;
    const h = qbt.header;
    const centerX = h.originX + h.extentX / 2;
    const centerY = h.originY + h.extentY / 2;

    const container = containerRef.current;
    const { clientWidth, clientHeight } = container;

    // Deck creates a canvas inside the container — ensure it fills it
    const canvas = document.createElement('canvas');
    canvas.style.position = 'absolute';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    container.appendChild(canvas);

    const deck = new Deck({
      canvas,
      width: '100%',
      height: '100%',
      views: new OrthographicView({ id: 'ortho', flipY: false }),
      initialViewState: {
        target: [centerX, centerY, 0],
        zoom: -Math.log2(Math.max(h.extentX, h.extentY) / Math.min(clientWidth, clientHeight)),
      },
      controller: true,
      layers: [],
      getTooltip: ({ object }: any) => object && `Value: ${object.value?.toLocaleString()}`,
    });
    deckRef.current = deck;
    return () => { deck.finalize(); deckRef.current = null; canvas.remove(); };
  }, [qbt]);

  // Update layers
  useEffect(() => {
    if (!deckRef.current) return;
    const layers: any[] = [];

    // Grid lines in native CRS
    layers.push(...buildGridLinesNative(qbt));

    // Node counts or scatterplot
    // For ortho, always show scatterplot since there's no "map zoom" concept
    // Use deck zoom to decide
    if (leafCells.length > 0) {
      layers.push(buildScatterLayerNative(leafCells, cellStats.min, cellStats.max, qbt));
    } else {
      // Show node counts at a reasonable level
      const nodes = getNodesAtLevelNative(qbt, Math.min(4, qbt.header.zoom - 1));
      layers.push(buildNodeCountLayerNative(nodes));
    }

    deckRef.current.setProps({ layers });
  }, [leafCells, cellStats, qbt]);

  return (
    <>
      <div ref={containerRef} style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: '#ffffff', overflow: 'hidden' }} />
      <HeaderPanel qbt={qbt} fileName={fileName} activeField={activeField} onFieldChange={setActiveField} />
      <DropZone onFile={loadFile} hasFile={true} />
    </>
  );
}

// ════════════════════════════════════════════════════════════════
// Main App — routes to GeoViewer or OrthoViewer
// ════════════════════════════════════════════════════════════════

function App() {
  const { qbt, fileName, loading, loadStatus, error, bbox, showBasemap, derivedGrid, loadFile } = useQBTFile();

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      {/* No file loaded yet — show drop zone on blank map */}
      {!qbt && !loading && !error && (
        <>
          <Map mapStyle={BASEMAP_STYLE} initialViewState={{ longitude: 0, latitude: 20, zoom: 2 }} style={{ width: '100%', height: '100%' }} />
          <DropZone onFile={loadFile} hasFile={false} />
        </>
      )}

      {/* Loaded: geo mode */}
      {qbt && showBasemap && bbox && (
        <GeoViewer qbt={qbt} fileName={fileName} bbox={bbox} loadFile={loadFile} derivedGrid={derivedGrid} />
      )}

      {/* Loaded: ortho mode (custom CRS) */}
      {qbt && !showBasemap && (
        <OrthoViewer qbt={qbt} fileName={fileName} loadFile={loadFile} />
      )}

      {/* Loading overlay */}
      {loading && (
        <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', background: 'rgba(0,0,0,0.8)', color: '#fff', padding: '20px 32px', borderRadius: 8, fontSize: 15, zIndex: 30 }}>
          {loadStatus}
        </div>
      )}

      {/* Error overlay */}
      {error && (
        <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', background: 'rgba(180,40,40,0.9)', color: '#fff', padding: '20px 32px', borderRadius: 8, fontSize: 14, maxWidth: 400, zIndex: 30 }}>
          <strong>Error:</strong> {error}
          <div style={{ marginTop: 12 }}><DropZone onFile={loadFile} hasFile={false} /></div>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
