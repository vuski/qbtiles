import {
  useState,
  useCallback,
  useRef,
  useEffect,
  type ReactNode,
  type PointerEvent as RPointerEvent,
} from 'react';
import Map from 'react-map-gl/maplibre';
import type { ViewStateChangeEvent, MapRef } from 'react-map-gl/maplibre';
import { DeckGLOverlay } from '../../components/DeckGLOverlay';
import type { Layer } from '@deck.gl/core';
import type { BBox } from '../../lib/geo-constants';
import { SelectionRect, bboxToGeoJSON, cornersToGeoJSON } from './SelectionRect';
import type maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

export interface ViewState {
  longitude: number;
  latitude: number;
  zoom: number;
  pitch?: number;
  bearing?: number;
}

interface SplitMapProps {
  viewState: ViewState;
  onViewStateChange: (vs: ViewState) => void;
  leftLayers: Layer[];
  rightLayers: Layer[];
  bbox: BBox;
  onBboxChange: (bbox: BBox) => void;
  children?: ReactNode;
}

export function SplitMap({
  viewState,
  onViewStateChange,
  leftLayers,
  rightLayers,
  bbox,
  onBboxChange,
  children,
}: SplitMapProps) {
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const leftMapRef = useRef<MapRef>(null);
  const rightMapRef = useRef<MapRef>(null);

  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Resize maps when split changes
  useEffect(() => {
    leftMapRef.current?.getMap().resize();
    rightMapRef.current?.getMap().resize();
  }, [splitRatio]);

  const handleMove = useCallback(
    (evt: ViewStateChangeEvent) => onViewStateChange(evt.viewState as ViewState),
    [onViewStateChange],
  );

  // Sync the other map's selection rect during drag (no React re-render)
  const syncOtherMap = useCallback((otherMapRef: React.RefObject<MapRef | null>, otherId: string) => {
    return (newBbox: BBox) => {
      const map = otherMapRef.current?.getMap();
      if (!map) return;
      const src = map.getSource(`${otherId}-rect-src`) as maplibregl.GeoJSONSource | undefined;
      const cSrc = map.getSource(`${otherId}-corner-src`) as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData(bboxToGeoJSON(newBbox));
      if (cSrc) cSrc.setData(cornersToGeoJSON(newBbox));
    };
  }, []);

  const onLeftDrag = useCallback(syncOtherMap(rightMapRef, 'sel-right'), [syncOtherMap]);
  const onRightDrag = useCallback(syncOtherMap(leftMapRef, 'sel-left'), [syncOtherMap]);

  const onDividerDown = useCallback((e: RPointerEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: globalThis.PointerEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const ratio = isMobile
        ? (e.clientY - rect.top) / rect.height
        : (e.clientX - rect.left) / rect.width;
      setSplitRatio(Math.max(0.2, Math.min(0.8, ratio)));
    };
    const onUp = () => setDragging(false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragging, isMobile]);

  const flexDir = isMobile ? 'column' : 'row';
  const leftSize = `${splitRatio * 100}%`;
  const rightSize = `${(1 - splitRatio) * 100}%`;
  const dividerCursor = isMobile ? 'row-resize' : 'col-resize';

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: flexDir as any,
      }}
    >
      {/* Left / Top map */}
      <div style={{ position: 'relative', [isMobile ? 'height' : 'width']: leftSize, overflow: 'hidden' }}>
        <Map
          ref={leftMapRef}
          {...viewState}
          onMove={handleMove}
          mapStyle={MAP_STYLE}
          style={{ width: '100%', height: '100%' }}
        >
          <DeckGLOverlay layers={leftLayers} />
          <SelectionRect
            mapRef={leftMapRef}
            bbox={bbox}
            onBboxChange={onBboxChange}
            onLiveDrag={onLeftDrag}
            fillColor="rgba(66, 133, 244, 0.2)"
            id="sel-left"
          />
        </Map>
      </div>

      {/* Divider */}
      <div
        onPointerDown={onDividerDown}
        style={{
          [isMobile ? 'height' : 'width']: 6,
          [isMobile ? 'width' : 'height']: '100%',
          backgroundColor: '#333',
          cursor: dividerCursor,
          flexShrink: 0,
          zIndex: 10,
          position: 'relative',
        }}
      />

      {/* Right / Bottom map */}
      <div style={{ position: 'relative', [isMobile ? 'height' : 'width']: rightSize, overflow: 'hidden' }}>
        <Map
          ref={rightMapRef}
          {...viewState}
          onMove={handleMove}
          mapStyle={MAP_STYLE}
          style={{ width: '100%', height: '100%' }}
        >
          <DeckGLOverlay layers={rightLayers} />
          <SelectionRect
            mapRef={rightMapRef}
            bbox={bbox}
            onBboxChange={onBboxChange}
            onLiveDrag={onRightDrag}
            fillColor="rgba(255, 152, 0, 0.2)"
            id="sel-right"
          />
        </Map>
      </div>

      {/* Overlay children (Compare button, stats panels) */}
      {children}
    </div>
  );
}

