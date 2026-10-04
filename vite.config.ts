import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
// The attribute is what Node's own loader needs for JSON; Vite's native config loader, due to
// become its default, refuses the import without it.
import pkg from './package.json' with { type: 'json' };

// The client lives in ./client; the built bundle goes to ./dist/client, which
// the Express server serves in production. In dev, Vite proxies API and auth
// routes to the API server on :3000.
export default defineConfig({
  root: 'client',
  plugins: [react()],
  // Shown in Settings → Data. The bundle and the server ship in one image, so this is the running
  // version; an `edge` build carries the last release's number until the next bump.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    // Vite inlines an imported asset under 4 kB as a `data:` URL, which the CSP
    // (server/security.ts) refuses: a short sound clip would be fetched from one and blocked.
    // Every asset stays a file under /assets.
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
    // No `host`: Vite's default keeps the dev server on localhost, off whatever network the
    // laptop is on. `npm run dev:client -- --host` opens it up for a test on a phone.
    proxy: {
      '/api': 'http://localhost:3000',
      '/auth': 'http://localhost:3000',
    },
  },
  test: {
    environment: 'node',
    include: ['client/src/**/*.test.{ts,tsx}', 'server/**/*.test.ts', 'shared/**/*.test.ts'],
    root: '.',
    // The server logs every setup, sign-in and retention run, so the route tests would fill a
    // green run with them. A failing test still prints its own output, and
    // `npm test -- --reporter=default --silent=false` shows everything. The reporter flag matters
    // under an agent, where Vitest picks its minimal reporter, which hides passing tests' output
    // whatever `silent` says.
    silent: 'passed-only',
    // The CI runner is UTC, which has no DST, so a DST case would prove nothing there. Los
    // Angeles is the owner's zone and the one the meal rules follow.
    env: { TZ: 'America/Los_Angeles' },
    // `npm run test:coverage` is the gate: every file below must be fully covered on all four
    // metrics or the run fails. The set is what the suite is meant to prove: the server, shared,
    // the client's API calls, the pure client libs and the hooks (their tests run under
    // happy-dom). Vitest leaves out the test files themselves (everything `include` above
    // matches). Also left out on purpose: the two process entrypoints (index.ts and cli.ts only
    // wire things up and call process.exit; what reset-password does is in auth/reset.ts, which
    // is covered), dev tooling (seed, harness), and the components. Some components have tests
    // for the logic they hold; how they look is checked in the browser. An unreachable branch is
    // deleted, never hidden behind a v8 ignore comment.
    coverage: {
      include: ['server/**', 'shared/**', 'client/src/api.ts', 'client/src/lib/**', 'client/src/hooks/**'],
      exclude: ['server/dev/**', 'server/index.ts', 'server/cli.ts'],
      reporter: ['text', 'html'],
      // Only files short of 100% are listed, so a clean run prints one summary line.
      skipFull: true,
      thresholds: { 100: true, perFile: true },
    },
  },
});
