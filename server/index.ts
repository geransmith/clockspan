import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { createApp } from './app.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`[config] ${(err as Error).message}`);
  process.exit(1);
}

if (config.authMode === 'none') {
  console.warn('[auth] AUTH_MODE=none: anyone who can reach this port has full access. Set AUTH_MODE=local or oidc before exposing it.');
}
if (config.trustProxy === true) {
  console.warn(
    '[proxy] TRUST_PROXY=true trusts any X-Forwarded-For a client sends, which defeats the login rate limit. Set it to the number of proxies in front of the app, usually 1.',
  );
}

const db = openDatabase(config.dbPath);
const app = createApp(db, config);

const server = app.listen(config.port, () => {
  console.log(`Clockspan listening on :${config.port} (auth: ${config.authMode}, db: ${config.dbPath})`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
