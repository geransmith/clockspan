import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as oidc from 'openid-client';
import { startTestApp, type TestApp } from '../dev/harness.js';
import { SESSION_COOKIE } from './session.js';
import { Discovery } from './oidc.js';

/**
 * The code grant against a provider. `oidc.test.ts` covers the routes with an unreachable
 * issuer; here discovery answers a real `Configuration` built from static metadata, so
 * `buildAuthorizationUrl` and `buildEndSessionUrl` run for real, and only the two calls that
 * would go over the network (the token exchange and userinfo) are faked.
 */
vi.mock('openid-client', async (importOriginal) => {
  const real = await importOriginal<typeof import('openid-client')>();
  return { ...real, discovery: vi.fn(), authorizationCodeGrant: vi.fn(), fetchUserInfo: vi.fn() };
});

const ISSUER = 'https://idp.example.com/application/o/clockspan/';
const metadata = (endSession: boolean): oidc.ServerMetadata => ({
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}authorize/`,
  token_endpoint: `${ISSUER}token/`,
  userinfo_endpoint: `${ISSUER}userinfo/`,
  ...(endSession ? { end_session_endpoint: `${ISSUER}end-session/` } : {}),
});
const configuration = (endSession = true) => new oidc.Configuration(metadata(endSession), 'clockspan', 'secret');

type Grant = Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
const grant = (claims: Record<string, unknown> | undefined): Grant => ({ access_token: 'at', token_type: 'bearer', claims: () => claims }) as unknown as Grant;

describe('OIDC code grant', () => {
  let app: TestApp;
  beforeEach(async () => {
    vi.mocked(oidc.discovery).mockResolvedValue(configuration());
    vi.mocked(oidc.authorizationCodeGrant).mockReset();
    vi.mocked(oidc.fetchUserInfo).mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    app = await startTestApp({ authMode: 'oidc', env: { OIDC_ISSUER: ISSUER } });
  });
  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  const raw = (path: string, cookie?: string) => fetch(app.url + path, { redirect: 'manual', headers: cookie ? { cookie } : {} });

  /** Starts the flow: the redirect to the provider plus the one-time cookie it left behind. */
  const login = async () => {
    const r = await raw('/auth/login');
    expect(r.status).toBe(302);
    const to = new URL(r.headers.get('location')!);
    const cookie = r.headers.getSetCookie().find((c) => c.startsWith('fs_oidc='))!;
    const pair = cookie.split(';')[0]!;
    const flow = JSON.parse(decodeURIComponent(pair.slice('fs_oidc='.length))) as { codeVerifier: string; state: string };
    return { to, cookie, pair, flow };
  };

  const callback = (claims: Record<string, unknown> | undefined, userinfo?: Record<string, unknown> | Error) =>
    login().then(async ({ to, pair, flow }) => {
      vi.mocked(oidc.authorizationCodeGrant).mockResolvedValue(grant(claims));
      if (userinfo instanceof Error) vi.mocked(oidc.fetchUserInfo).mockRejectedValue(userinfo);
      else if (userinfo) vi.mocked(oidc.fetchUserInfo).mockResolvedValue(userinfo as oidc.UserInfoResponse);
      const r = await raw(`/auth/callback?code=abc&state=${to.searchParams.get('state')}`, pair);
      return { r, flow, to };
    });

  it('sends the browser to the provider with PKCE and a state it keeps in a short-lived cookie', async () => {
    const { to, cookie, flow } = await login();
    expect(to.origin + to.pathname).toBe(`${ISSUER}authorize/`);
    expect(to.searchParams.get('client_id')).toBe('clockspan');
    expect(to.searchParams.get('redirect_uri')).toBe('http://localhost/auth/callback');
    expect(to.searchParams.get('scope')).toBe('openid profile email');
    expect(to.searchParams.get('code_challenge_method')).toBe('S256');
    expect(to.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    expect(to.searchParams.get('state')).toBe(flow.state);
    expect(flow.codeVerifier).toMatch(/^[\w-]{43,}$/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/auth/i);
    expect(cookie).toMatch(/Max-Age=600/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it('exchanges the code with the verifier and state from the cookie, signs the user in, and clears the cookie', async () => {
    const { r, flow, to } = await callback({ sub: 'u1', name: 'Ada' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/');
    const [config, currentUrl, checks] = vi.mocked(oidc.authorizationCodeGrant).mock.calls[0]!;
    expect(config.serverMetadata().issuer).toBe(ISSUER);
    expect((currentUrl as URL).href).toBe(`http://localhost/auth/callback?code=abc&state=${to.searchParams.get('state')}`);
    expect(checks).toEqual({ pkceCodeVerifier: flow.codeVerifier, expectedState: flow.state });
    const cookies = r.headers.getSetCookie();
    expect(cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`))).toMatch(/HttpOnly/i);
    expect(cookies.find((c) => c.startsWith('fs_oidc='))).toMatch(/Max-Age=0/i);
    expect(app.db.prepare(`SELECT oidc_sub, display_name, is_admin FROM users`).all()).toEqual([
      { oidc_sub: `${ISSUER}|u1`, display_name: 'Ada', is_admin: 1 },
    ]);
    expect(oidc.fetchUserInfo).not.toHaveBeenCalled();

    // The session works: the cookie the browser got opens the data routes.
    const session = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`))!.split(';')[0]!;
    const me = await fetch(`${app.url}/api/auth/me`, { headers: { cookie: session } });
    expect(((await me.json()) as { user: { name: string } }).user.name).toBe('Ada');
  });

  it('takes the name from the claims in order, then from userinfo, then falls back to the subject', async () => {
    const names = () => (app.db.prepare(`SELECT display_name FROM users ORDER BY id`).all() as { display_name: string }[]).map((u) => u.display_name);
    expect((await callback({ sub: 'a', preferred_username: 'ada', email: 'ada@example.com' })).r.status).toBe(302);
    expect((await callback({ sub: 'b', email: 'bob@example.com' })).r.status).toBe(302);
    expect((await callback({ sub: 'c' }, { sub: 'c', name: 'Cy' })).r.status).toBe(302);
    expect((await callback({ sub: 'd' }, { sub: 'd', preferred_username: 'dee' })).r.status).toBe(302);
    expect((await callback({ sub: 'e' }, { sub: 'e', email: 'e@example.com' })).r.status).toBe(302);
    expect((await callback({ sub: 'f' }, { sub: 'f' })).r.status).toBe(302);
    expect((await callback({ sub: 'g' }, new Error('userinfo down'))).r.status).toBe(302);
    expect(names()).toEqual(['ada', 'bob@example.com', 'Cy', 'dee', 'e@example.com', 'f', 'g']);
    expect(oidc.fetchUserInfo).toHaveBeenCalledTimes(5);
    expect(vi.mocked(oidc.fetchUserInfo).mock.calls[0]!.slice(1)).toEqual(['at', 'c']);
  });

  it('refuses a token response without a subject and still clears the cookie', async () => {
    for (const claims of [undefined, {}]) {
      const { r } = await callback(claims);
      expect(r.status).toBe(400);
      expect(await r.text()).toBe('Sign-in failed: ID token has no subject. <a href="/auth/login">Try again</a>.');
      expect(r.headers.getSetCookie().find((c) => c.startsWith('fs_oidc='))).toMatch(/Max-Age=0/i);
      expect(r.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
    }
    expect(app.db.prepare(`SELECT COUNT(*) AS n FROM users`).get()).toEqual({ n: 0 });
  });

  it('logs out locally and hands back the provider end-session URL when it has one', async () => {
    const { r } = await callback({ sub: 'u1', name: 'Ada' });
    const session = r.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`))!
      .split(';')[0]!;
    const out = await fetch(`${app.url}/api/auth/logout`, { method: 'POST', headers: { cookie: session } });
    const body = (await out.json()) as { ok: boolean; redirect: string | null };
    expect(body.ok).toBe(true);
    const end = new URL(body.redirect!);
    expect(end.origin + end.pathname).toBe(`${ISSUER}end-session/`);
    expect(end.searchParams.get('post_logout_redirect_uri')).toBe('http://localhost');
    expect(end.searchParams.get('client_id')).toBe('clockspan');
    expect(app.db.prepare(`SELECT COUNT(*) AS n FROM auth_sessions`).get()).toEqual({ n: 0 });

    // A provider without RP-initiated logout: the local logout is all there is.
    vi.mocked(oidc.discovery).mockResolvedValue(configuration(false));
    await app.close();
    app = await startTestApp({ authMode: 'oidc', env: { OIDC_ISSUER: ISSUER } });
    expect((await app.api.post('/api/auth/logout')).body).toEqual({ ok: true, redirect: null });
  });
});

describe('Discovery', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries with backoff until the provider answers, then remembers the answer', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = configuration();
    vi.mocked(oidc.discovery).mockReset().mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValue(c);

    const d = new Discovery(ISSUER, 'clockspan', 'secret');
    const warm = d.warm();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(error).toHaveBeenCalledWith(`[oidc] discovery failed (ECONNREFUSED); retrying in 2s`);
    expect(log).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await warm;
    expect(log).toHaveBeenCalledWith(`[oidc] discovered issuer ${ISSUER}`);
    expect(oidc.discovery).toHaveBeenCalledTimes(2);
    expect(vi.mocked(oidc.discovery).mock.calls[0]!.slice(0, 3)).toEqual([new URL(ISSUER), 'clockspan', 'secret']);
    // Cached from here on: no third call.
    expect(await d.get()).toBe(c);
    expect(oidc.discovery).toHaveBeenCalledTimes(2);
  });
});
