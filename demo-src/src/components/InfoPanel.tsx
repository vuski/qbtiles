import type { ReactNode } from 'react';

interface InfoPanelProps {
  title: string;
  children?: ReactNode;
}

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  top: 12,
  right: 12,
  padding: '12px 16px',
  backgroundColor: 'rgba(0, 0, 0, 0.72)',
  color: '#fff',
  borderRadius: 8,
  fontFamily: 'system-ui, sans-serif',
  fontSize: 14,
  lineHeight: 1.5,
  maxWidth: 320,
  pointerEvents: 'auto',
};

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 16,
  fontWeight: 600,
};

export function InfoPanel({ title, children }: InfoPanelProps) {
  return (
    <div style={panelStyle}>
      <h3 style={titleStyle}>{title}</h3>
      {children}
    </div>
  );
}
