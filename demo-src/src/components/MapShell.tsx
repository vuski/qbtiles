import { useState, useCallback, useRef, type ReactNode } from 'react';
import Map from 'react-map-gl/maplibre';
import type maplibregl from 'maplibre-gl';
import { DeckGLOverlay } from './DeckGLOverlay';
import type { Layer } from '@deck.gl/core';
import type { ViewStateChangeEvent, MapRef } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';

const DEFAULT_STYLE =
  'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

interface MapShellProps {
  initialViewState: {
    longitude: number;
    latitude: number;
    zoom: number;
    pitch?: number;
    bearing?: number;
  };
  layers?: Layer[];
  mapStyle?: string;
  onMapLoad?: (map: maplibregl.Map) => void;
  children?: ReactNode;
}

export function MapShell({
  initialViewState,
  layers = [],
  mapStyle = DEFAULT_STYLE,
  onMapLoad,
  children,
}: MapShellProps) {
  const [viewState, setViewState] = useState(initialViewState);
  const mapRef = useRef<MapRef>(null);

  const handleLoad = useCallback(() => {
    if (mapRef.current && onMapLoad) {
      onMapLoad(mapRef.current.getMap());
    }
  }, [onMapLoad]);

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Map
        ref={mapRef}
        {...viewState}
        onMove={(evt: ViewStateChangeEvent) => setViewState(evt.viewState)}
        onLoad={handleLoad}
        mapStyle={mapStyle}
        style={{ width: '100%', height: '100%' }}
      >
        <DeckGLOverlay layers={layers} />
        {children}
      </Map>
    </div>
  );
}
