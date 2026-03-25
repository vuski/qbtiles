/**
 * Selection rectangle rendered as a MapLibre GeoJSON layer.
 * The rect lives on the map plane — it tilts/rotates with pitch/bearing.
 * Drag to move, drag corners to resize.
 *
 * Key: during drag, we update the GeoJSON source directly (no React re-render)
 * to avoid flickering. The parent bbox state is only updated on mouseup.
 */
import { useEffect, useRef, useCallback, type RefObject } from 'react';
import type { MapRef } from 'react-map-gl/maplibre';
import type maplibregl from 'maplibre-gl';
import type { BBox } from '../../lib/geo-constants';

interface SelectionRectProps {
  mapRef: RefObject<MapRef | null>;
  bbox: BBox;
  onBboxChange: (bbox: BBox) => void;
  /** Called every mousemove during drag — use to sync the other map's rect */
  onLiveDrag?: (bbox: BBox) => void;
  fillColor?: string;
  lineColor?: string;
  id?: string;
}

type DragMode = 'move' | 'nw' | 'ne' | 'sw' | 'se' | null;

const HANDLE_RADIUS_PX = 14;

export function bboxToGeoJSON(bbox: BBox): GeoJSON.Feature<GeoJSON.Polygon> {
  const [w, s, e, n] = bbox;
  // MapLibre can render coordinates beyond ±180 — no clamping needed
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
    },
  };
}

export function cornersToGeoJSON(bbox: BBox): GeoJSON.FeatureCollection<GeoJSON.Point> {
  const [w, s, e, n] = bbox;
  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { corner: 'sw' }, geometry: { type: 'Point', coordinates: [w, s] } },
      { type: 'Feature', properties: { corner: 'se' }, geometry: { type: 'Point', coordinates: [e, s] } },
      { type: 'Feature', properties: { corner: 'ne' }, geometry: { type: 'Point', coordinates: [e, n] } },
      { type: 'Feature', properties: { corner: 'nw' }, geometry: { type: 'Point', coordinates: [w, n] } },
    ],
  };
}

export function SelectionRect({
  mapRef,
  bbox,
  onBboxChange,
  onLiveDrag,
  fillColor = 'rgba(66, 133, 244, 0.2)',
  lineColor = 'rgba(255, 255, 255, 0.8)',
  id = 'selection',
}: SelectionRectProps) {
  // Live bbox ref — updated during drag without React re-render
  const liveBbox = useRef<BBox>([...bbox] as BBox);
  // Stable ref for live drag callback (avoids effect re-registration)
  const onLiveDragRef = useRef(onLiveDrag);
  onLiveDragRef.current = onLiveDrag;
  const dragRef = useRef<{
    mode: DragMode;
    startX: number;
    startY: number;
    startBbox: BBox;
    lngPerPx: number;
    latPerPx: number;
  } | null>(null);
  const setupDone = useRef(false);

  const srcId = `${id}-rect-src`;
  const fillLayerId = `${id}-rect-fill`;
  const lineLayerId = `${id}-rect-line`;
  const cornerSrcId = `${id}-corner-src`;
  const cornerLayerId = `${id}-corner-layer`;

  // Sync from parent prop (when not dragging)
  useEffect(() => {
    if (dragRef.current) return; // don't overwrite during drag
    liveBbox.current = [...bbox] as BBox;
    updateSources();
  }, [bbox]);

  // Direct GeoJSON update — no React state involved
  const updateSources = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    const src = map.getSource(srcId) as maplibregl.GeoJSONSource | undefined;
    const cSrc = map.getSource(cornerSrcId) as maplibregl.GeoJSONSource | undefined;
    if (src) src.setData(bboxToGeoJSON(liveBbox.current));
    if (cSrc) cSrc.setData(cornersToGeoJSON(liveBbox.current));
  }, [mapRef, srcId, cornerSrcId]);

  // Setup layers once
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;

    const setup = () => {
      if (setupDone.current || map.getSource(srcId)) return;
      setupDone.current = true;

      map.addSource(srcId, { type: 'geojson', data: bboxToGeoJSON(liveBbox.current) });
      map.addLayer({
        id: fillLayerId,
        type: 'fill',
        source: srcId,
        paint: { 'fill-color': fillColor, 'fill-opacity': 1 },
      });
      map.addLayer({
        id: lineLayerId,
        type: 'line',
        source: srcId,
        paint: { 'line-color': lineColor, 'line-width': 2 },
      });
      map.addSource(cornerSrcId, { type: 'geojson', data: cornersToGeoJSON(liveBbox.current) });
      map.addLayer({
        id: cornerLayerId,
        type: 'circle',
        source: cornerSrcId,
        paint: {
          'circle-radius': 6,
          'circle-color': '#fff',
          'circle-stroke-color': '#333',
          'circle-stroke-width': 1.5,
        },
      });
    };

    if (map.isStyleLoaded()) setup();
    else map.on('load', setup);

    return () => {
      map.off('load', setup);
      try {
        if (map.getLayer(cornerLayerId)) map.removeLayer(cornerLayerId);
        if (map.getLayer(lineLayerId)) map.removeLayer(lineLayerId);
        if (map.getLayer(fillLayerId)) map.removeLayer(fillLayerId);
        if (map.getSource(cornerSrcId)) map.removeSource(cornerSrcId);
        if (map.getSource(srcId)) map.removeSource(srcId);
      } catch { /* map may be destroyed */ }
      setupDone.current = false;
    };
  }, [mapRef.current]);

  // Interaction handlers — stable ref, never re-registered
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;

    function hitTest(point: { x: number; y: number }): DragMode {
      // Guard: layers may not be added yet
      if (!map!.getLayer(cornerLayerId) || !map!.getLayer(fillLayerId)) return null;

      // Check corners first (circle layer)
      const cornerHits = map!.queryRenderedFeatures(
        [[point.x - HANDLE_RADIUS_PX, point.y - HANDLE_RADIUS_PX],
         [point.x + HANDLE_RADIUS_PX, point.y + HANDLE_RADIUS_PX]],
        { layers: [cornerLayerId] },
      );
      if (cornerHits.length > 0) {
        const corner = cornerHits[0].properties?.corner;
        if (corner === 'sw' || corner === 'se' || corner === 'ne' || corner === 'nw') {
          return corner as DragMode;
        }
      }
      // Check inside fill
      const fillHits = map!.queryRenderedFeatures([point.x, point.y], { layers: [fillLayerId] });
      if (fillHits.length > 0) return 'move';
      return null;
    }

    function onMouseDown(e: maplibregl.MapMouseEvent) {
      const mode = hitTest(e.point);
      if (!mode) return;
      e.preventDefault();
      // Compute degrees-per-pixel from zoom + latitude (pure math, no map.project)
      const zoom = map!.getZoom();
      const [, s, , n] = liveBbox.current;
      const centerLat = (s + n) / 2;
      const cosLat = Math.cos((centerLat * Math.PI) / 180);
      // MapLibre uses 512px tiles (not 256)
      const worldPx = 512 * Math.pow(2, zoom);
      const lngPerPx = 360 / (worldPx * cosLat);
      // Mercator latitude: approximate for small regions
      const latPerPx = 360 / worldPx;

      dragRef.current = {
        mode,
        startX: e.point.x,
        startY: e.point.y,
        startBbox: [...liveBbox.current] as BBox,
        lngPerPx,
        latPerPx,
      };
      map!.dragPan.disable();
      map!.dragRotate.disable();
      map!.getCanvas().style.cursor = mode === 'move' ? 'grabbing' : `${mode}-resize`;
    }

    function onMouseMove(e: maplibregl.MapMouseEvent) {
      const drag = dragRef.current;
      if (!drag) {
        const mode = hitTest(e.point);
        map!.getCanvas().style.cursor = mode === 'move' ? 'grab' : mode ? `${mode}-resize` : '';
        return;
      }

      const dx = e.point.x - drag.startX;
      const dy = e.point.y - drag.startY;
      const [w, s, ea, n] = drag.startBbox;

      const dLng = dx * drag.lngPerPx;
      const dLat = -dy * drag.latPerPx;

      let newBbox: BBox;
      if (drag.mode === 'move') {
        newBbox = [w + dLng, s + dLat, ea + dLng, n + dLat];
      } else {
        let nw = w, ns = s, ne = ea, nn = n;
        if (drag.mode === 'sw') { nw += dLng; ns += dLat; }
        else if (drag.mode === 'se') { ne += dLng; ns += dLat; }
        else if (drag.mode === 'ne') { ne += dLng; nn += dLat; }
        else if (drag.mode === 'nw') { nw += dLng; nn += dLat; }
        if (ne - nw < 0.1 || nn - ns < 0.1) return;
        // Max size: 10° × 10° (~1000km × 1000km)
        if (ne - nw > 10) ne = nw + 10;
        if (nn - ns > 10) nn = ns + 10;
        newBbox = [nw, ns, ne, nn];
      }

      liveBbox.current = newBbox;
      updateSources();
      onLiveDragRef.current?.(newBbox);
    }

    function onMouseUp() {
      if (!dragRef.current) return;
      // Normalize west to [-180, 180) to prevent coordinate drift
      let [w, s, e, n] = liveBbox.current;
      const width = e - w;
      while (w >= 180) w -= 360;
      while (w < -180) w += 360;
      e = w + width;
      const normalized: BBox = [w, s, e, n];
      liveBbox.current = normalized;
      updateSources();

      dragRef.current = null;
      map!.dragPan.enable();
      map!.dragRotate.enable();
      map!.getCanvas().style.cursor = '';
      onBboxChange(normalized);
    }

    map.on('mousedown', onMouseDown);
    map.on('mousemove', onMouseMove);
    map.on('mouseup', onMouseUp);
    const windowUp = () => onMouseUp();
    window.addEventListener('mouseup', windowUp);

    return () => {
      map.off('mousedown', onMouseDown);
      map.off('mousemove', onMouseMove);
      map.off('mouseup', onMouseUp);
      window.removeEventListener('mouseup', windowUp);
    };
  }, [mapRef.current, updateSources, onBboxChange]);

  return null;
}
