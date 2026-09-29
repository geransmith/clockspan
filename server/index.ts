import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { createApp, startBackgroundJobs } from './app.js';
import { Discovery } from './auth/oidc.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`[config] ${(err as Error).message}`);
  process.exit(1);
}

if (config.authMode === 'none') {
  console.warn('[auth] AUTH_MODE=none: anyone who can reach this port has full access. Set AUTH_MODE=local or oidc unless you trust everyone who can.');
} else if (config.allowedHosts.length > 0) {
  console.warn(`[host] ALLOWED_HOSTS is only read under AUTH_MODE=none; with ${config.authMode} sign-in the session cookie already stays with the real name.`);
}
if (config.trustProxy === true) {
  console.warn(
    '[proxy] TRUST_PROXY=true trusts any X-Forwarded-For a client sends, which defeats the login rate limit. Set it to the number of proxies in front of the app, usually 1.',
  );
}

const db = openDatabase(config.dbPath);
// One lookup for the sign-in routes and the warm-up, so the first sign-in finds it done.
const discovery = config.oidc ? new Discovery(config.oidc.issuer, config.oidc.clientId, config.oidc.clientSecret) : undefined;
const app = createApp(db, config, { discovery });
startBackgroundJobs(db, config, discovery);

const server = app.listen(config.port, () => {
  console.log(`Clockspan listening on :${config.port} (auth: ${config.authMode}, db: ${config.dbPath})`);
});

// Docker sends SIGKILL 10 s after SIGTERM. close() waits for requests in flight, so a stuck
// one would take the container the hard way; exit a little before that instead. The timer
// is unref'd so a clean close is not held up by it. Only the first signal starts a shutdown.
const SHUTDOWN_DEADLINE_MS = 8_000;
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    console.log(`[server] ${sig}: closing`);
    setTimeout(() => {
      console.error(`[server] still open after ${SHUTDOWN_DEADLINE_MS / 1000}s; exiting`);
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS).unref();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
