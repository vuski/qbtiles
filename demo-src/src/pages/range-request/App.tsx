import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MapShell } from '../../components/MapShell';
import { InfoPanel } from '../../components/InfoPanel';

function App() {
  return (
    <MapShell
      initialViewState={{ longitude: 127, latitude: 37.5, zoom: 5 }}
    >
      <InfoPanel title="Demo 3: Range Request">
        <p style={{ margin: '8px 0 0' }}>
          QBTiles HTTP range request demo — coming soon.
        </p>
      </InfoPanel>
    </MapShell>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
