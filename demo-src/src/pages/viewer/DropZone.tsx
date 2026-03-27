import { useState, useCallback, useRef, type DragEvent } from 'react';

interface DropZoneProps {
  onFile: (buffer: ArrayBuffer, fileName: string) => void;
  hasFile: boolean;
}

export function DropZone({ onFile, hasFile }: DropZoneProps) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback(
    async (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (!file) return;
      const buffer = await file.arrayBuffer();
      onFile(buffer, file.name);
    },
    [onFile],
  );

  const handleFileInput = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const buffer = await file.arrayBuffer();
      onFile(buffer, file.name);
    },
    [onFile],
  );

  if (hasFile) {
    return (
      <button
        onClick={() => inputRef.current?.click()}
        style={{
          position: 'absolute',
          bottom: 16,
          left: '50%',
          transform: 'translateX(-50%)',
          padding: '8px 20px',
          background: 'rgba(0,0,0,0.7)',
          color: '#fff',
          border: '1px solid #555',
          borderRadius: 6,
          cursor: 'pointer',
          fontSize: 13,
          zIndex: 10,
        }}
      >
        Open another file
        <input
          ref={inputRef}
          type="file"
          accept=".qbt,.gz"
          onChange={handleFileInput}
          style={{ display: 'none' }}
        />
      </button>
    );
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: dragging ? 'rgba(74, 144, 217, 0.15)' : 'rgba(0,0,0,0.6)',
        border: dragging ? '3px dashed #4a90d9' : '3px dashed #555',
        cursor: 'pointer',
        zIndex: 20,
        transition: 'background 0.15s, border-color 0.15s',
      }}
    >
      <div style={{ fontSize: 48, marginBottom: 16 }}>+</div>
      <div style={{ color: '#fff', fontSize: 20, fontWeight: 600 }}>
        Drop a .qbt or .qbt.gz file here
      </div>
      <div style={{ color: '#888', fontSize: 14, marginTop: 8 }}>
        or click to browse
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".qbt,.gz"
        onChange={handleFileInput}
        style={{ display: 'none' }}
      />
    </div>
  );
}
