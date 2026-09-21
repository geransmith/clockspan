import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { createApp } from '../app.js';
import { loadConfig, type Config } from '../config.js';
import { ensureDefaultUser, openDatabase, type DB } from '../db.js';
import { seedDatabase, type SeedManifest, type SeedOptions } from './seed.js';

/**
 * Boots the real Express app on an in-memory SQLite DB and talks to it over HTTP with
 * Node's fetch. No mocks: a test exercises the same middleware, validation and SQL the
 * client hits. Start one per test (`beforeEach`) — boot is a few milliseconds and it keeps
 * the DB and the per-app login limiter isolated. Response bodies are typed `any` on purpose:
 * they are whatever the route sent, and tests assert on them loosely.
 */

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export interface Client {
  get<T = any>(path: string): Promise<ApiResponse<T>>;
  post<T = any>(path: string, body?: unknown): Promise<ApiResponse<T>>;
  put<T = any>(path: string, body?: unknown): Promise<ApiResponse<T>>;
  patch<T = any>(path: string, body?: unknown): Promise<ApiResponse<T>>;
  del<T = any>(path: string): Promise<ApiResponse<T>>;
  /** Cookies this client is currently sending (name → value). */
  cookies(): Record<string, string>;
}

export interface TestApp {
  db: DB;
  config: Config;
  url: string;
  /** Default client. In AUTH_MODE=none every request is the default user. */
  api: Client;
  /** A client with its own cookie jar, e.g. a second user. */
  client(): Client;
  /** Set when started with `seed`. */
  seeded?: SeedManifest;
  close(): Promise<void>;
}

export interface StartOptions {
  /** `oidc` points discovery at a port nothing listens on: the routes that don't need the provider can still be tested. */
  authMode?: 'none' | 'local' | 'oidc';
  /** Seed the default user (AUTH_MODE=none only); pass options to override the defaults. */
  seed?: boolean | Partial<Omit<SeedOptions, 'userId'>>;
  /** Extra environment for `loadConfig`, e.g. `{ RETENTION_DAYS: '30' }`. */
  env?: Record<string, string>;
}

/** A Wednesday, so "this week" in a review holds seeded days on both sides. */
export const SEED_TODAY = '2026-09-16';
export const SEED_NOW = new Date(2026, 8, 16, 14, 0).getTime();

function makeClient(baseUrl: string): Client {
  const jar = new Map<string, string>();
  const request = async <T>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(baseUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const raw of res.headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a));
      if (expired || value === '') jar.delete(name);
      else jar.set(name, value);
    }
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body (static file); keep the text */
    }
    return { status: res.status, body: parsed as T, headers: res.headers };
  };
  return {
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b ?? {}),
    put: (p, b) => request('PUT', p, b ?? {}),
    patch: (p, b) => request('PATCH', p, b ?? {}),
    del: (p) => request('DELETE', p),
    cookies: () => Object.fromEntries(jar),
  };
}

export async function startTestApp(opts: StartOptions = {}): Promise<TestApp> {
  const authMode = opts.authMode ?? 'none';
  const oidcEnv =
    authMode === 'oidc' ? { OIDC_ISSUER: 'http://127.0.0.1:1/', OIDC_CLIENT_ID: 'clockspan', OIDC_CLIENT_SECRET: 'secret', APP_URL: 'http://localhost' } : {};
  const config = loadConfig({ AUTH_MODE: authMode, DATA_DIR: os.tmpdir(), PORT: '0', ...oidcEnv, ...opts.env });
  const db = openDatabase(':memory:');
  const app = createApp(db, config);
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  let seeded: SeedManifest | undefined;
  if (opts.seed) {
    if (authMode !== 'none') throw new Error('seed: true needs authMode "none"; under local auth create users first and call seedDatabase yourself.');
    const user = ensureDefaultUser(db);
    const extra = typeof opts.seed === 'object' ? opts.seed : {};
    seeded = seedDatabase(db, { userId: user.id, today: SEED_TODAY, now: SEED_NOW, ...extra });
  }

  return {
    db,
    config,
    url,
    api: makeClient(url),
    client: () => makeClient(url),
    seeded,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          db.close();
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}
