import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, statSync, createReadStream, copyFileSync, mkdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Serve a local directory with Range Request support. */
function serveLocal(baseDir: string) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const filePath = resolve(__dirname, '..', baseDir, (req.url ?? '').replace(/^\//, ''));
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
  };
}

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    {
      name: 'serve-local-data',
      configureServer(server) {
        server.middlewares.use('/ref', serveLocal('ref'));
        server.middlewares.use('/examples', serveLocal('examples'));
      },
      closeBundle() {
        // Copy data files from examples/ to build output for production
        const copies: [string, string][] = [
          ['examples/korea_tiles.qbt', 'docs/demo/tiles/korea_tiles.qbt'],
          ['examples/korea_pop_100m.qbt.gz', 'docs/demo/population/korea_pop_100m.qbt.gz'],
        ];
        for (const [src, dest] of copies) {
          const srcPath = resolve(__dirname, '..', src);
          const destPath = resolve(__dirname, '..', dest);
          if (existsSync(srcPath)) {
            mkdirSync(dirname(destPath), { recursive: true });
            copyFileSync(srcPath, destPath);
          }
        }
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
