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
    include: ['client/src/**/*.test.ts', 'server/**/*.test.ts', 'shared/**/*.test.ts'],
    root: '.',
    // `npm run test:coverage` is the gate: every file below must be fully covered on all four
    // metrics or the run fails. The set is what the suite is meant to prove: the server, shared,
    // and the pure client libs. Left out on purpose: the two process entrypoints (index.ts and
    // cli.ts only wire things up and call process.exit), dev tooling (seed, harness), and the
    // components and hooks, which are verified in the browser. An unreachable branch is deleted,
    // never hidden behind a v8 ignore comment.
    coverage: {
      provider: 'v8',
      include: ['server/**', 'shared/**', 'client/src/lib/**'],
      exclude: ['server/dev/**', 'server/index.ts', 'server/cli.ts', '**/*.test.ts'],
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage',
      // Only files short of 100% are listed, so a clean run prints one summary line.
      skipFull: true,
      thresholds: { 100: true, perFile: true },
    },
  },
});
