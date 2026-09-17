import { Router } from 'express';
import { parseCookie, stringifySetCookie } from 'cookie';
import * as oidc from 'openid-client';
import type { DB, UserRow } from '../db.js';
import type { Config } from '../config.js';
import { cookieOptions, createSession, destroySession } from './session.js';
import { publicUser } from './local.js';
import type { AuthInfo } from '../../shared/api.js';

const FLOW_COOKIE = 'fs_oidc';
const FLOW_TTL_SEC = 600;
/** The provider's claim is stored as-is otherwise; a name is a label, not a document. */
const MAX_DISPLAY_NAME = 100;

/** The two error pages are HTML with a retry link; anything interpolated into them goes through this. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * Discovery is retried lazily with backoff so the app still boots (and serves the
 * sign-in page) when the identity provider is briefly unavailable.
 */
class Discovery {
  private promise: Promise<oidc.Configuration> | null = null;
  private lastError: unknown = null;

  constructor(private readonly issuer: string, private readonly clientId: string, private readonly clientSecret: string) {}

  get(): Promise<oidc.Configuration> {
    if (!this.promise) {
      this.promise = oidc.discovery(new URL(this.issuer), this.clientId, this.clientSecret).catch((err) => {
        this.lastError = err;
        this.promise = null;
        throw err;
      });
    }
    return this.promise;
  }

  async warm(): Promise<void> {
    let delay = 2000;
    for (;;) {
      try {
        await this.get();
        console.log(`[oidc] discovered issuer ${this.issuer}`);
        return;
      } catch (err) {
        console.error(`[oidc] discovery failed (${(err as Error).message}); retrying in ${delay / 1000}s`);
        // unref: a provider that never answers must not keep the process (or a test) alive.
        await new Promise((r) => setTimeout(r, delay).unref());
        delay = Math.min(delay * 2, 60_000);
      }
    }
  }

  get error(): unknown {
    return this.lastError;
  }
}

export function upsertOidcUser(db: DB, sub: string, rawName: string): UserRow {
  const displayName = rawName.slice(0, MAX_DISPLAY_NAME);
  const existing = db.prepare(`SELECT * FROM users WHERE oidc_sub = ?`).get(sub) as UserRow | undefined;
  if (existing) {
    if (existing.display_name !== displayName) {
      db.prepare(`UPDATE users SET display_name = ? WHERE id = ?`).run(displayName, existing.id);
      existing.display_name = displayName;
    }
    return existing;
  }
  // First OIDC user becomes admin so someone can manage things later if needed.
  const anyUser = db.prepare(`SELECT 1 FROM users WHERE kind = 'oidc' LIMIT 1`).get();
  const info = db
    .prepare(`INSERT INTO users (kind, oidc_sub, display_name, is_admin, created_at) VALUES ('oidc', ?, ?, ?, ?)`)
    .run(sub, displayName, anyUser ? 0 : 1, Date.now());
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(info.lastInsertRowid) as UserRow;
}

export function oidcAuthRouter(db: DB, config: Config): { api: Router; web: Router } {
  const o = config.oidc!;
  const appUrl = config.appUrl!;
  const redirectUri = `${appUrl}/auth/callback`;
  const discovery = new Discovery(o.issuer, o.clientId, o.clientSecret);
  void discovery.warm();

  const api = Router();
  const web = Router();

  api.get('/me', (req, res) => {
    const info: AuthInfo = { mode: 'oidc', setupRequired: false, user: req.user ? publicUser(req.user) : null };
    res.json(info);
  });

  api.post('/logout', async (req, res) => {
    destroySession(db, config, req, res);
    let endSession: string | null = null;
    try {
      const c = await discovery.get();
      if (c.serverMetadata().end_session_endpoint) {
        endSession = oidc.buildEndSessionUrl(c, { post_logout_redirect_uri: appUrl }).href;
      }
    } catch {
      // Provider unreachable; local logout is enough.
    }
    res.json({ ok: true, redirect: endSession });
  });

  web.get('/login', async (_req, res) => {
    let c: oidc.Configuration;
    try {
      c = await discovery.get();
    } catch (err) {
      res.status(503).send(`Identity provider is unreachable: ${escapeHtml((err as Error).message)}`);
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
      res.status(400).send('Sign-in session expired. <a href="/auth/login">Try again</a>.');
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
      let name = (claims.name as string | undefined) ?? (claims.preferred_username as string | undefined) ?? (claims.email as string | undefined);
      if (!name) {
        try {
          const info = await oidc.fetchUserInfo(c, tokens.access_token, claims.sub);
          name = info.name ?? info.preferred_username ?? info.email;
        } catch {
          // Fall through to the subject as a last resort.
        }
      }
      const user = upsertOidcUser(db, `${o.issuer}|${claims.sub}`, name ?? claims.sub);
      createSession(db, config, res, user.id);
      // createSession set the session cookie; also clear the one-time flow cookie.
      res.setHeader('Set-Cookie', [res.getHeader('Set-Cookie') as string, clearFlow]);
      res.redirect('/');
    } catch (err) {
      console.error('[oidc] callback failed:', err);
      res.setHeader('Set-Cookie', clearFlow);
      res.status(400).send(`Sign-in failed: ${escapeHtml((err as Error).message)}. <a href="/auth/login">Try again</a>.`);
    }
  });

  return { api, web };
}
