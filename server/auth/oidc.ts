import { Router } from 'express';
import { parseCookie, stringifySetCookie } from 'cookie';
import * as oidc from 'openid-client';
import { findUserById, type DB, type UserRow } from '../db.js';
import type { Config } from '../config.js';
import { cookieOptions, createSession, destroySession } from './session.js';
import { logName, publicUser } from './users.js';
import type { AuthInfo, LogoutResponse } from '../../shared/api.js';
import { nextBackoff } from '../../shared/backoff.js';

const FLOW_COOKIE = 'fs_oidc';
const FLOW_TTL_SEC = 600;
/** The provider's claim is stored as-is otherwise; a name is a label, not a document. */
const MAX_DISPLAY_NAME = 100;

/**
 * The error pages a browser lands on. Fixed text: the error itself goes to the log, since a
 * provider's or the network's message can name internal hosts to whoever opened the page.
 */
const RETRY = '<a href="/auth/login">Try again</a>.';
const PROVIDER_DOWN = `Identity provider is unreachable. ${RETRY}`;
const SIGN_IN_FAILED = `Sign-in failed. ${RETRY}`;

/** The first value that is a non-empty string: which name claims a provider fills, and with what, varies. */
function firstName(...values: unknown[]): string | undefined {
  return values.find((v): v is string => typeof v === 'string' && v.trim() !== '');
}

/**
 * openid-client's messages are generic: every connection problem is fetch's "fetch failed", and
 * any status but 200 is "unexpected HTTP response status code". The cause says which: refused,
 * a name that doesn't resolve, a certificate Node doesn't trust, a 404.
 */
function reason(err: unknown): string {
  const { message, cause } = err as Error;
  if (cause instanceof Response) return `${message}: HTTP ${cause.status}`;
  // An AggregateError (every address of a name refused) carries its detail in `errors`, not here.
  if (cause instanceof Error && cause.message) return `${message}: ${cause.message}`;
  return message;
}

/**
 * No connection (fetch's TypeError), a timeout or a 5xx is a provider that is down or still
 * starting, as it is for a while when a whole server boots at once. Every other ClientError is
 * about the URL or what it answered (a 404, a page that isn't metadata, an issuer that doesn't
 * match), and asking again gets the same answer until OIDC_ISSUER or the provider changes.
 */
function worthRetrying(err: unknown): boolean {
  if (!(err instanceof oidc.ClientError)) return true;
  return err.code === 'OAUTH_TIMEOUT' || (err.cause instanceof Response && err.cause.status >= 500);
}

/**
 * Discovery is retried lazily with backoff so the app still boots (and serves the
 * sign-in page) when the identity provider is briefly unavailable.
 */
export class Discovery {
  private promise: Promise<oidc.Configuration> | null = null;
  private resolved: oidc.Configuration | null = null;

  constructor(
    private readonly issuer: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  get(): Promise<oidc.Configuration> {
    if (!this.promise) {
      this.promise = oidc.discovery(new URL(this.issuer), this.clientId, this.clientSecret).then(
        (c) => {
          this.resolved = c;
          return c;
        },
        (err: unknown) => {
          this.promise = null;
          throw err;
        },
      );
    }
    return this.promise;
  }

  /** The provider's configuration once a discovery has succeeded; null before, and it never starts one. */
  current(): oidc.Configuration | null {
    return this.resolved;
  }

  /** Started by `startBackgroundJobs`, so building an app contacts no provider and leaves no timer behind. */
  async warm(): Promise<void> {
    let delay = 0;
    for (;;) {
      try {
        await this.get();
        console.log(`[oidc] discovered issuer ${this.issuer}`);
        return;
      } catch (err) {
        if (!worthRetrying(err)) {
          // Once: a line a minute forever would bury it. A sign-in still asks again.
          console.error(
            `[oidc] discovery failed (${reason(err)}); not retrying, since the answer won't change. Check OIDC_ISSUER against the provider's issuer URL.`,
          );
          return;
        }
        delay = nextBackoff(delay);
        console.error(`[oidc] discovery failed (${reason(err)}); retrying in ${delay / 1000}s`);
        // unref: a provider that never answers must not keep the process (or a test) alive.
        await new Promise((r) => setTimeout(r, delay).unref());
      }
    }
  }
}

export function upsertOidcUser(db: DB, issuer: string, sub: string, rawName: string): UserRow {
  // Stored in users.oidc_sub: changing its form orphans every OIDC account without a migration.
  const key = `${issuer}|${sub}`;
  const displayName = rawName.slice(0, MAX_DISPLAY_NAME);
  const existing = db.prepare(`SELECT * FROM users WHERE oidc_sub = ?`).get(key) as UserRow | undefined;
  if (existing) {
    if (existing.display_name !== displayName) {
      db.prepare(`UPDATE users SET display_name = ? WHERE id = ?`).run(displayName, existing.id);
      existing.display_name = displayName;
    }
    return existing;
  }
  // The first OIDC user is marked admin, like the first local account. Nothing reads the flag
  // under OIDC yet: the provider decides who signs in, and the Users tab is local-only.
  const anyUser = db.prepare(`SELECT 1 FROM users WHERE kind = 'oidc' LIMIT 1`).get();
  const info = db
    .prepare(`INSERT INTO users (kind, oidc_sub, display_name, is_admin, created_at) VALUES ('oidc', ?, ?, ?, ?)`)
    .run(key, displayName, anyUser ? 0 : 1, Date.now());
  return findUserById(db, info.lastInsertRowid)!;
}

/** `given` is the Discovery the entrypoint warms in `startBackgroundJobs`; without one, the routes look the provider up on the first sign-in. */
export function oidcAuthRouter(db: DB, config: Config, given?: Discovery): { api: Router; web: Router } {
  const o = config.oidc!;
  const appUrl = config.appUrl!;
  const redirectUri = `${appUrl}/auth/callback`;
  const discovery = given ?? new Discovery(o.issuer, o.clientId, o.clientSecret);

  const api = Router();
  const web = Router();

  api.get('/me', (req, res) => {
    res.json({ mode: 'oidc', setupRequired: false, user: req.user ? publicUser(req.user) : null, cookieSecure: config.cookieSecure } satisfies AuthInfo);
  });

  api.post('/logout', (req, res) => {
    destroySession(db, config, req, res);
    let endSession: string | null = null;
    // Only an answer discovery already has: asking the provider now would hold Sign out for up
    // to openid-client's 30 s timeout while it is down, and the local logout is what counts.
    const c = discovery.current();
    if (c?.serverMetadata().end_session_endpoint) {
      try {
        endSession = oidc.buildEndSessionUrl(c, { post_logout_redirect_uri: appUrl }).href;
      } catch {
        // An endpoint openid-client won't send a browser to (plain http); local logout is enough.
      }
    }
    res.json({ ok: true, redirect: endSession } satisfies LogoutResponse);
  });

  web.get('/login', async (_req, res) => {
    let c: oidc.Configuration;
    try {
      c = await discovery.get();
    } catch (err) {
      console.error(`[oidc] sign-in refused, provider unreachable: ${reason(err)}`);
      res.status(503).send(PROVIDER_DOWN);
      return;
    }
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const url = oidc.buildAuthorizationUrl(c, {
      redirect_uri: redirectUri,
      scope: o.scopes,
      code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
      state,
    });
    res.setHeader(
      'Set-Cookie',
      stringifySetCookie({ name: FLOW_COOKIE, value: JSON.stringify({ codeVerifier, state }), ...cookieOptions(config, '/auth'), maxAge: FLOW_TTL_SEC }),
    );
    res.redirect(url.href);
  });

  web.get('/callback', async (req, res) => {
    const raw = req.headers.cookie ? parseCookie(req.headers.cookie)[FLOW_COOKIE] : undefined;
    if (!raw) {
      res.status(400).send(`Sign-in session expired. ${RETRY}`);
      return;
    }
    const clearFlow = stringifySetCookie({ name: FLOW_COOKIE, value: '', ...cookieOptions(config, '/auth'), maxAge: 0 });
    try {
      const { codeVerifier, state } = JSON.parse(raw) as { codeVerifier: string; state: string };
      const c = await discovery.get();
      // Reconstruct the public callback URL from APP_URL so this works behind a reverse proxy.
      const currentUrl = new URL(req.originalUrl, appUrl);
      const tokens = await oidc.authorizationCodeGrant(c, currentUrl, {
        pkceCodeVerifier: codeVerifier,
        expectedState: state,
      });
      const claims = tokens.claims();
      if (!claims?.sub) throw new Error('ID token has no subject');
      let name = firstName(claims.name, claims.preferred_username, claims.email);
      if (!name) {
        try {
          const info = await oidc.fetchUserInfo(c, tokens.access_token, claims.sub);
          name = firstName(info.name, info.preferred_username, info.email);
        } catch {
          // Fall through to the subject as a last resort.
        }
      }
      const user = upsertOidcUser(db, o.issuer, claims.sub, name ?? claims.sub);
      createSession(db, config, res, user.id);
      console.log(`[oidc] ${logName(user.display_name)} (#${user.id}) signed in`);
      // createSession set the session cookie; this clears the one-time flow cookie beside it.
      res.append('Set-Cookie', clearFlow);
      res.redirect('/');
    } catch (err) {
      console.error('[oidc] callback failed:', err);
      res.setHeader('Set-Cookie', clearFlow);
      res.status(400).send(SIGN_IN_FAILED);
    }
  });

  return { api, web };
}
