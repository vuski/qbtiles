import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig(({ command }) => ({
  plugins: [react()],
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
