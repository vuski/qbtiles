import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, statSync, createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    {
      name: 'serve-ref',
      configureServer(server) {
        server.middlewares.use('/ref', (req: IncomingMessage, res: ServerResponse, next: () => void) => {
          const filePath = resolve(__dirname, '..', 'ref', (req.url ?? '').replace(/^\//, ''));
          if (!existsSync(filePath)) return next();
          const stat = statSync(filePath);
          const range = req.headers.range;
          if (range) {
            const [startStr, endStr] = range.replace('bytes=', '').split('-');
            const start = parseInt(startStr, 10);
            const end = endStr ? parseInt(endStr, 10) : stat.size - 1;
            res.writeHead(206, {
              'Content-Range': `bytes ${start}-${end}/${stat.size}`,
              'Accept-Ranges': 'bytes',
              'Content-Length': end - start + 1,
              'Content-Type': 'application/octet-stream',
              'Access-Control-Allow-Origin': '*',
            });
            createReadStream(filePath, { start, end }).pipe(res);
          } else {
            res.writeHead(200, {
              'Content-Length': stat.size,
              'Content-Type': 'application/octet-stream',
              'Accept-Ranges': 'bytes',
              'Access-Control-Allow-Origin': '*',
            });
            createReadStream(filePath).pipe(res);
          }
        });
      },
    },
  ],
  base: command === 'serve' ? '/' : '/qbtiles/demo/',
  build: {
    outDir: '../docs/demo',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        tiles: resolve(__dirname, 'tiles/index.html'),
        population: resolve(__dirname, 'population/index.html'),
        'range-request': resolve(__dirname, 'range-request/index.html'),
        viewer: resolve(__dirname, 'viewer/index.html'),
      },
    },
  },
  resolve: {
    alias: {
      '@lib': resolve(__dirname, 'src/lib'),
      'qbtiles': resolve(__dirname, '../src/typescript/qbtiles.ts'),
    },
  },
}));
