import { InfoPanel } from '../../components/InfoPanel';
import type { QBT } from 'qbtiles';

const TYPE_NAMES: Record<number, string> = {
  1: 'uint8', 2: 'int16', 3: 'uint16', 4: 'int32', 5: 'uint32',
  6: 'float32', 7: 'float64', 8: 'int64', 9: 'uint64', 10: 'varint',
};

interface HeaderPanelProps {
  qbt: QBT;
  fileName: string;
  activeField?: string;
  onFieldChange?: (field: string) => void;
}

const fmt = (n: number) =>
  n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : n >= 1024
      ? `${(n / 1024).toFixed(1)} KB`
      : `${n} B`;

export function HeaderPanel({ qbt, fileName, activeField, onFieldChange }: HeaderPanelProps) {
  const h = qbt.header;
  const row: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 12 };
  const label: React.CSSProperties = { color: '#999' };
  const val: React.CSSProperties = { color: '#fff', fontFamily: 'monospace', fontSize: 12 };
  const btnStyle = (active: boolean): React.CSSProperties => ({
    padding: '3px 10px',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
    backgroundColor: active ? '#4a90d9' : '#555',
    color: '#fff',
  });

  const fields = h.fields;
  const showFieldButtons = fields.length > 1 && onFieldChange;

  return (
    <InfoPanel title="QBT Viewer">
      <div style={{ marginTop: 8, fontSize: 13, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={row}><span style={label}>File</span><span style={val}>{fileName}</span></div>
        <div style={row}><span style={label}>Mode</span><span style={val}>{qbt.mode}</span></div>
        <div style={row}><span style={label}>Zoom</span><span style={val}>{h.zoom}</span></div>
        <div style={row}><span style={label}>CRS</span><span style={val}>EPSG:{h.crs || 'custom'}</span></div>
        <div style={row}><span style={label}>Leaves</span><span style={val}>{qbt.leafCount.toLocaleString()}</span></div>
        <div style={row}><span style={label}>Bitmask</span><span style={val}>{fmt(Number(h.bitmaskLength))}</span></div>
        {fields.length > 0 && (
          <div style={{ marginTop: 4 }}>
            <span style={label}>Fields: </span>
            <span style={val}>
              {fields.map((f) => `${f.name} (${TYPE_NAMES[f.type] || f.type})`).join(', ')}
            </span>
          </div>
        )}
        {showFieldButtons && (
          <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {fields.map((f) => (
              <button
                key={f.name}
                style={btnStyle(activeField === f.name)}
                onClick={() => onFieldChange(f.name)}
              >
                {f.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </InfoPanel>
  );
}
