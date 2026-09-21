import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import type { Config } from './config.js';
import type { DB } from './db.js';
import { currentUser, requireAuth, resolveUser } from './auth/middleware.js';
import { localAuthRouter, publicUser } from './auth/local.js';
import { oidcAuthRouter } from './auth/oidc.js';
import { purgeExpiredSessions } from './auth/session.js';
import { scheduleRetention } from './retention.js';
import { securityHeaders } from './security.js';
import { daysRouter } from './routes/days.js';
import { sessionStartRouter, sessionsRouter } from './routes/sessions.js';
import { settingsRouter } from './routes/settings.js';
import type { AuthInfo } from '../shared/api.js';

export interface AppOptions {
  /** Where the built client lives; the default is `dist/client` next to the built server. */
  clientDir?: string;
}

export function createApp(db: DB, config: Config, opts: AppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy !== false) app.set('trust proxy', config.trustProxy);
  app.use(securityHeaders(config));
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.use(resolveUser(db, config));

  // ----- auth -----
  if (config.authMode === 'local') {
    app.use('/api/auth', localAuthRouter(db, config));
  } else if (config.authMode === 'oidc') {
    const { api, web } = oidcAuthRouter(db, config);
    app.use('/api/auth', api);
    app.use('/auth', web);
  } else {
    app.get('/api/auth/me', (req, res) => {
      // resolveUser attaches the default user to every request in this mode.
      const info: AuthInfo = { mode: 'none', setupRequired: false, user: publicUser(currentUser(req)) };
      res.json(info);
    });
  }

  // ----- data (all behind auth, all scoped to req.user) -----
  const api = express.Router();
  api.use(requireAuth);
  api.use('/settings', settingsRouter(db));
  api.use('/days/:date/sessions', sessionStartRouter(db));
  api.use('/days', daysRouter(db, config));
  api.use('/sessions', sessionsRouter(db));
  app.use('/api', api);

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

  // ----- static SPA (production build) -----
  const clientDir = opts.clientDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client');
  if (fs.existsSync(path.join(clientDir, 'index.html'))) {
    // Vite fingerprints everything under /assets, so those can be cached for good; the
    // manifest, icons and service worker keep the short default so an update shows up.
    app.use(
      express.static(clientDir, {
        index: false,
        maxAge: '1h',
        setHeaders: (res, filePath) => {
          if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        },
      }),
    );
    app.get('/{*splat}', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(clientDir, 'index.html'));
    });
  }

  // JSON error handler so malformed bodies etc. don't leak stack traces.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = (err as { status?: number }).status ?? 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Internal error.' : (err as Error).message });
  });

  setInterval(purgeExpiredSessions, 6 * 3_600_000, db).unref();
  scheduleRetention(db, config);

  return app;
}
