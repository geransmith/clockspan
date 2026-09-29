import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import type { Config } from './config.js';
import type { DB } from './db.js';
import { currentUser, requireAuth, requireOwnPassword, resolveUser } from './auth/middleware.js';
import { localAuthRouter } from './auth/local.js';
import { publicUser } from './auth/users.js';
import { oidcAuthRouter } from './auth/oidc.js';
import { purgeExpiredSessions } from './auth/session.js';
import { scheduleRetention } from './retention.js';
import { rejectCrossSiteWrites, rejectUnknownHosts, securityHeaders } from './security.js';
import { breakStartRouter, breaksRouter } from './routes/breaks.js';
import { daysRouter } from './routes/days.js';
import { sessionStartRouter, sessionsRouter } from './routes/sessions.js';
import { settingsRouter } from './routes/settings.js';
import type { AuthInfo, OkResponse } from '../shared/api.js';
import { HOUR_MS } from '../shared/dates.js';

export interface AppOptions {
  /** Where the built client lives; the default is `dist/client` next to the built server. */
  clientDir?: string;
  /** AUTH_MODE=local's first-run setup code. Only tests fix it; a server makes its own. */
  setupCode?: string;
}

export function createApp(db: DB, config: Config, opts: AppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy !== false) app.set('trust proxy', config.trustProxy);
  app.use(securityHeaders(config));
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true } satisfies OkResponse));
  // With no sign-in, the Host header is what tells the owner's browser from a rebound name.
  if (config.authMode === 'none') app.use('/api', rejectUnknownHosts(config));
  app.use('/api', rejectCrossSiteWrites(config));

  // Only the API reads req.user. Resolving the session for a static file would slide its
  // expiry and hand the token back in a Set-Cookie on an answer marked `public` and cacheable;
  // a shared cache that stores it would serve one user's session to the next.
  app.use('/api', resolveUser(db, config));

  // ----- auth -----
  if (config.authMode === 'local') {
    app.use('/api/auth', localAuthRouter(db, config, opts.setupCode));
  } else if (config.authMode === 'oidc') {
    const { api, web } = oidcAuthRouter(db, config);
    app.use('/api/auth', api);
    app.use('/auth', web);
  } else {
    app.get('/api/auth/me', (req, res) => {
      // resolveUser attaches the default user to every request in this mode.
      res.json({ mode: 'none', setupRequired: false, user: publicUser(currentUser(req)), cookieSecure: config.cookieSecure } satisfies AuthInfo);
    });
  }

  // ----- data (all behind auth, all scoped to req.user) -----
  const api = express.Router();
  api.use(requireAuth, requireOwnPassword);
  api.use('/settings', settingsRouter(db));
  api.use('/days/:date/sessions', sessionStartRouter(db));
  api.use('/days/:date/breaks', breakStartRouter(db));
  api.use('/days', daysRouter(db, config));
  api.use('/sessions', sessionsRouter(db));
  api.use('/breaks', breaksRouter(db));
  app.use('/api', api);

  const notFound: express.RequestHandler = (_req, res) => {
    res.status(404).json({ error: 'Not found.' });
  };
  app.use('/api', notFound);

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
    // /assets holds only the build's fingerprinted files, so a miss there is never a client
    // route: it is a page from before an upgrade asking for the old build's chunk. The shell
    // in its place would be refused as a script with a MIME-type error; a 404 says what happened.
    app.use('/assets', notFound);
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

  return app;
}

/**
 * The server's timers: expired logins purged every few hours, and old days pruned
 * (`scheduleRetention`). The process entrypoint starts them after `createApp`, so building an
 * app (every test does) starts nothing. Both are unref'd and never hold the process open.
 */
export function startBackgroundJobs(db: DB, config: Config): void {
  // A timer's throw is an uncaught exception: one busy or full database would end the server.
  const purge = () => {
    try {
      purgeExpiredSessions(db);
    } catch (err) {
      console.error('[sessions]', err);
    }
  };
  setInterval(purge, 6 * HOUR_MS).unref();
  scheduleRetention(db, config);
}
