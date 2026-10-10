import path from 'node:path';
import fs from 'node:fs';
import { findPackageJSON } from 'node:module';
import express, { type Express } from 'express';
import type { Config } from './config.js';
import { bumpRevision, readRevision, type DB } from './db.js';
import { currentUser, requireAuth, requireOwnPassword, resolveUser } from './auth/middleware.js';
import { localAuthRouter } from './auth/local.js';
import { hasLocalUser, publicUser } from './auth/users.js';
import { oidcAuthRouter, type Discovery } from './auth/oidc.js';
import { purgeExpiredSessions } from './auth/session.js';
import { runRetention } from './retention.js';
import { refuse } from './refuse.js';
import { READ_METHODS, rejectCrossSiteWrites, rejectUnknownHosts, securityHeaders } from './security.js';
import { boardRouter } from './routes/board.js';
import { breaksRouter } from './routes/breaks.js';
import { daysRouter } from './routes/days.js';
import { itemsRouter } from './routes/items.js';
import { sessionsRouter } from './routes/sessions.js';
import { settingsRouter } from './routes/settings.js';
import { REVISION_HEADER, VERSION_HEADER, type AuthInfo, type OkResponse } from '../shared/api.js';
import { HOUR_MS } from '../shared/dates.js';

/**
 * This server's version, from the nearest package.json: the repo's in dev and tests, and in the
 * image the one copied beside dist/, which is also the file that makes dist/server an ES module.
 */
const VERSION = (JSON.parse(fs.readFileSync(findPackageJSON(import.meta.url)!, 'utf8')) as { version: string }).version;

export interface AppOptions {
  /** Where the built client lives; the default is `dist/client` next to the built server. */
  clientDir?: string;
  /** AUTH_MODE=local's first-run setup code. Only tests fix it; a server makes its own. */
  setupCode?: string;
  /** AUTH_MODE=oidc's provider lookup, shared with `startBackgroundJobs`, which warms it. Without one, the OIDC router makes its own. */
  discovery?: Discovery;
}

export function createApp(db: DB, config: Config, opts: AppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(securityHeaders(config));
  app.use(express.json({ limit: '256kb' }));
  // Express 5 leaves req.body undefined when nothing was parsed (no body, or not JSON), and
  // every route reads fields off it.
  app.use((req, _res, next) => {
    req.body ??= {};
    next();
  });

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
    const { api, web } = oidcAuthRouter(db, config, opts.discovery);
    app.use('/api/auth', api);
    app.use('/auth', web);
  }
  // After the mode's router, so a request for it passes the local router's warnUntrustedProxy
  // first. Under AUTH_MODE=none, resolveUser has attached the default user.
  app.get('/api/auth/me', (req, res) => {
    res.json({
      mode: config.authMode,
      setupRequired: config.authMode === 'local' && !hasLocalUser(db),
      user: req.user ? publicUser(req.user) : null,
      cookieSecure: config.cookieSecure,
    } satisfies AuthInfo);
  });

  // ----- data (all behind auth, all scoped to req.user) -----
  const api = express.Router();
  // Each data answer, a refusal included, names the server's version, so a page loaded before
  // an update can tell and ask for a reload (client/src/api.ts), and the user's revision: a
  // write moves it on before its handler runs, refused or not, and a read answers it as it
  // stands. That number describes what the handler did only because no data handler awaits
  // (AGENTS.md). Only once signed in: the health check, the auth routes and a 401 get neither.
  api.use(requireAuth, requireOwnPassword, (req, res, next) => {
    res.setHeader(VERSION_HEADER, VERSION);
    const { id } = currentUser(req);
    res.setHeader(REVISION_HEADER, READ_METHODS.has(req.method) ? readRevision(db, id) : bumpRevision(db, id));
    next();
  });
  api.use('/settings', settingsRouter(db));
  api.use('/days', daysRouter(db, config));
  api.use('/sessions', sessionsRouter(db));
  api.use('/breaks', breaksRouter(db));
  api.use('/board', boardRouter(db));
  api.use('/items', itemsRouter(db));
  app.use('/api', api);

  const notFound: express.RequestHandler = (_req, res) => refuse(res, 404, 'Not found.');
  app.use('/api', notFound);

  // ----- static SPA (production build) -----
  const clientDir = opts.clientDir ?? path.resolve(import.meta.dirname, '../client');
  if (fs.existsSync(path.join(clientDir, 'index.html'))) {
    // Vite fingerprints everything under /assets, so those can be cached for good. The shell
    // is no-cache however it is asked for: kept after an upgrade, it would name the old build's
    // chunks. The manifest, icons and service worker keep the one-hour default so an update
    // shows up.
    app.use(
      express.static(clientDir, {
        index: false,
        maxAge: '1h',
        setHeaders: (res, filePath) => {
          // By the path inside the build: filePath is absolute, and an install under a folder
          // named assets would otherwise pin the icons, manifest and service worker for a year.
          const rel = path.relative(clientDir, filePath);
          if (rel.startsWith(`assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          else if (rel === 'index.html') res.setHeader('Cache-Control', 'no-cache');
        },
      }),
    );
    // /assets holds only the build's fingerprinted files, so a miss there is never a client
    // route: it is a page from before an upgrade asking for the old build's chunk. The shell
    // in its place would be refused as a script with a MIME-type error; a 404 says what happened.
    app.use('/assets', notFound);
    app.get('/{*splat}', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      // `root`, not an absolute path: send's dotfile rule checks every segment of an absolute
      // path, so an install under any folder starting with a dot (~/.local/share/…, a
      // .claude/worktrees checkout) would answer every page with a 404. With a root it checks only
      // the part inside it, as express.static does.
      res.sendFile('index.html', { root: clientDir });
    });
  }

  // JSON errors, never a stack trace. A 4xx's message is shown unless http-errors marks it
  // `expose: false`: send does that for a failed stat of the shell (a rebuild emptying
  // dist/client under a running server), and that message names the build's absolute path.
  // What isn't shown goes to the log.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = (err as { status?: number }).status ?? 500;
    const shown = status < 500 && (err as { expose?: boolean }).expose !== false;
    if (!shown) console.error(err);
    refuse(res, status, shown ? (err as Error).message : status >= 500 ? 'Internal error.' : 'Request failed.');
  });

  return app;
}

/**
 * The server's timers: expired logins purged every six hours, old days pruned
 * (`runRetention`) 30 s after boot and then every six hours, and under OIDC the provider looked
 * up until it answers (`Discovery.warm`, on the one `createApp` was given). The process
 * entrypoint starts them after `createApp`, so building an app (every test does) starts
 * nothing. All are unref'd and never hold the process open.
 */
export function startBackgroundJobs(db: DB, config: Config, discovery?: Discovery): void {
  // A timer's throw is an uncaught exception: one busy or full database would end the server.
  const guarded = (label: string, job: () => unknown) => () => {
    try {
      job();
    } catch (err) {
      console.error(label, err);
    }
  };
  const purge = guarded('[sessions]', () => purgeExpiredSessions(db));
  setInterval(purge, 6 * HOUR_MS).unref();
  const prune = guarded('[retention]', () => runRetention(db, config));
  setTimeout(prune, 30_000).unref();
  setInterval(prune, 6 * HOUR_MS).unref();
  if (discovery) void discovery.warm();
}
