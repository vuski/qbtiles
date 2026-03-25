import { StrictMode, useState, useEffect, useRef, useMemo, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { ColumnLayer, PolygonLayer } from "@deck.gl/layers";
import type { BBox } from "../../lib/geo-constants";
import { SplitMap, type ViewState } from "./SplitMap";
import { useQBTilesQuery } from "./useQBTilesQuery";
import { useCOGQuery } from "./useCOGQuery";
import type { QBTCellData } from "qbtiles";
import type { COGCellData } from "../../lib/cog-query";
import { TrafficChart } from "./TrafficChart";

const BITMASK_URL = "./global_pop_bitmask.gz";
const VALUES_URL = "https://assets.vw-lab.uk/qbtiles/global_pop_values.bin";
const COG_URL = "https://assets.vw-lab.uk/worldpop/world_pop_2025.tif";

// Seeded random chunk color
function chunkColor(index: number, alpha = 140): [number, number, number, number] {
  const hue = (index * 137.508) % 360;
  const s = 0.7, l = 0.55;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (hue < 60) { r = c; g = x; }
  else if (hue < 120) { r = x; g = c; }
  else if (hue < 180) { g = c; b = x; }
  else if (hue < 240) { g = x; b = c; }
  else if (hue < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
    alpha,
  ];
}

function fmt(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

interface ChartPoint {
  request: number;
  bytes: number;
}

function App() {
  const [viewState, setViewState] = useState<ViewState>({
    longitude: 127.5,
    latitude: 36,
    zoom: 7,
    pitch: 30,
    bearing: 0,
  });
  const [bbox, setBbox] = useState<BBox>([126.8, 37.4, 127.2, 37.7]);

  const qbt = useQBTilesQuery(BITMASK_URL, VALUES_URL);
  const cog = useCOGQuery(COG_URL);

  // ---- Cumulative traffic chart (X = user click count) ----
  const [qbtChart, setQbtChart] = useState<ChartPoint[]>([]);
  const [cogChart, setCogChart] = useState<ChartPoint[]>([]);
  const qbtCumBytes = useRef(0);
  const cogCumBytes = useRef(0);
  const clickCount = useRef(0);

  // Show index cost as click 0
  useEffect(() => {
    if (!qbt.state.indexLoading && qbt.state.indexBytes > 0 && qbtChart.length === 0) {
      qbtCumBytes.current = qbt.state.indexBytes;
      setQbtChart([{ request: 0, bytes: qbt.state.indexBytes }]);
      setCogChart([{ request: 0, bytes: 0 }]);
    }
  }, [qbt.state.indexLoading, qbt.state.indexBytes, qbtChart.length]);

  const handleCompare = useCallback(async () => {
    const click = ++clickCount.current;

    // QBTiles first, then COG — same server, avoids bandwidth contention
    const qbtResult = await qbt.query(bbox);
    const cogResult = await cog.query(bbox);

    const qbtBytes = qbtResult?.bytes ?? 0;
    const cogBytes = cogResult?.bytes ?? 0;

    qbtCumBytes.current += qbtBytes;
    cogCumBytes.current += cogBytes;

    setQbtChart((prev) => [...prev, { request: click, bytes: qbtCumBytes.current }]);
    setCogChart((prev) => [...prev, { request: click, bytes: cogCumBytes.current }]);
  }, [qbt.query, cog.query, bbox]);

  const isQuerying = qbt.state.querying || cog.state.querying;

  // QBTiles layers
  const leftLayers = useMemo(() => {
    if (!qbt.state.results || qbt.state.results.length === 0) return [];
    return [
      new ColumnLayer<QBTCellData>({
        id: "qbt-columns",
        data: qbt.state.results,
        getPosition: (d) => d.position,
        getElevation: (d) => d.value * 1,
        getFillColor: (d) => chunkColor(d.chunkIndex, 200) as any,
        diskResolution: 4,
        radius: 450,
        extruded: true,
        pickable: false,
        updateTriggers: { getFillColor: [] },
      }),
    ];
  }, [qbt.state.results]);

  // COG layers
  const rightLayers = useMemo(() => {
    const layers: any[] = [];
    if (cog.state.chunks.length > 0) {
      layers.push(
        new PolygonLayer({
          id: "cog-tile-blocks",
          data: cog.state.chunks,
          getPolygon: (d: any) => {
            const [w, s, e, n] = d.bbox;
            return [[w, s], [e, s], [e, n], [w, n], [w, s]];
          },
          getFillColor: (_: any, { index }: any) => chunkColor(index, 60) as any,
          getLineColor: [255, 255, 255, 150],
          getLineWidth: 1,
          lineWidthMinPixels: 1,
          stroked: true,
          filled: true,
        }),
      );
    }
    if (cog.state.results && cog.state.results.length > 0) {
      layers.push(
        new ColumnLayer<COGCellData>({
          id: "cog-columns",
          data: cog.state.results,
          getPosition: (d) => d.position,
          getElevation: (d) => d.value * 1,
          getFillColor: (d) => chunkColor(d.tileIndex, d.outside ? 100 : 200) as any,
          diskResolution: 4,
          radius: 450,
          extruded: true,
          pickable: false,
          updateTriggers: { getFillColor: [] },
        }),
      );
    }
    return layers;
  }, [cog.state.results, cog.state.chunks]);

  return (
    <SplitMap
      viewState={viewState}
      onViewStateChange={setViewState}
      leftLayers={leftLayers}
      rightLayers={rightLayers}
      bbox={bbox}
      onBboxChange={setBbox}
    >
      {/* Stats panels */}
      <div style={statsPanelStyle("left")}>
        <div style={{ fontWeight: 600, marginBottom: 2 }}>QBTiles</div>
        {qbt.state.indexLoading ? (
          <div>{qbt.state.indexProgress}</div>
        ) : qbt.state.error ? (
          <div style={{ color: "#ff6b6b" }}>{qbt.state.error}</div>
        ) : qbt.state.stats ? (
          <>
            <div>
              Requests: {qbt.state.stats.requests}
              {qbt.state.stats.cachedCells > 0 && (
                <span style={{ color: "#aaa" }}> / {qbt.state.stats.estimatedRequests}</span>
              )}
            </div>
            <div>
              Bytes: {fmt(qbt.state.stats.bytes)}
              {qbt.state.stats.cachedCells > 0 && (
                <span style={{ color: "#aaa" }}> / {fmt(qbt.state.stats.estimatedBytes)}</span>
              )}
            </div>
            <div>Cells: {qbt.state.stats.cells.toLocaleString()}</div>
            {qbt.state.stats.cachedCells > 0 && (
              <div style={{ color: "#7fc97f" }}>
                Cached: {qbt.state.stats.cachedCells.toLocaleString()}
              </div>
            )}
            <div>Time: {(qbt.state.stats.timeMs / 1000).toFixed(2)}s</div>
          </>
        ) : (
          <div style={{ color: "#aaa" }}>{qbt.state.indexProgress}</div>
        )}
      </div>

      <div style={statsPanelStyle("right")}>
        <div style={{ fontWeight: 600, marginBottom: 2 }}>COG (GeoTIFF)</div>
        {cog.state.error ? (
          <div style={{ color: "#ff6b6b" }}>{cog.state.error}</div>
        ) : cog.state.stats ? (
          (() => {
            const s = cog.state.stats;
            return (
              <>
                <div>Requests: {s.requests}</div>
                <div>Bytes: {fmt(s.bytes)}</div>
                <div>Tiles: {s.tileCount} (512×512)</div>
                <div>Cells: {s.cells.toLocaleString()}</div>
                {s.cachedTiles > 0 && (
                  <div style={{ color: "#7fc97f" }}>
                    Cached: {s.cachedTiles} / {s.tileCount} tiles
                  </div>
                )}
                <div>Time: {(s.timeMs / 1000).toFixed(2)}s</div>
              </>
            );
          })()
        ) : (
          <div style={{ color: "#aaa" }}>Ready</div>
        )}
      </div>

      {/* Traffic chart */}
      <TrafficChart qbtData={qbtChart} cogData={cogChart} />

      {/* Compare button */}
      <button
        onClick={handleCompare}
        disabled={isQuerying || qbt.state.indexLoading}
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 20,
          padding: "10px 28px",
          fontSize: 15,
          fontWeight: 600,
          fontFamily: "system-ui, sans-serif",
          border: "none",
          borderRadius: 8,
          cursor: isQuerying || qbt.state.indexLoading ? "not-allowed" : "pointer",
          backgroundColor: isQuerying || qbt.state.indexLoading ? "#666" : "#4a90d9",
          color: "#fff",
          boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
          transition: "background-color 0.2s",
        }}
      >
        {isQuerying ? "Comparing..." : "Compare"}
      </button>
    </SplitMap>
  );
}

const isMobileQuery = () => window.innerWidth < 768;

function statsPanelStyle(side: "left" | "right"): React.CSSProperties {
  const mobile = isMobileQuery();
  return {
    position: "absolute",
    top: mobile ? 4 : 12,
    [side === "left" ? "left" : "right"]: mobile ? 4 : 12,
    padding: mobile ? "4px 8px" : "10px 14px",
    backgroundColor: "rgba(0, 0, 0, 0.75)",
    color: "#fff",
    borderRadius: mobile ? 4 : 8,
    fontFamily: "system-ui, sans-serif",
    fontSize: mobile ? 11 : 13,
    lineHeight: mobile ? 1.2 : 1.5,
    zIndex: 15,
    pointerEvents: "auto",
    minWidth: mobile ? 100 : 140,
  };
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
