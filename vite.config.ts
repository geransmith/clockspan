import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The client lives in ./client; the built bundle goes to ./dist/client, which
// the Express server serves in production. In dev, Vite proxies API and auth
// routes to the API server on :3000.
export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': 'http://localhost:3000',
      '/auth': 'http://localhost:3000',
    },
  },
  test: {
    environment: 'node',
    include: ['client/src/**/*.test.ts'],
    root: '.',
  },
});
