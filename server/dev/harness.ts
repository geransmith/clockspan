import fs from 'node:fs';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { parseSetCookie, stringifyCookie } from 'cookie';
import { createApp } from '../app.js';
import type { Discovery } from '../auth/oidc.js';
import { changeFeed, type ChangeFeed } from '../changes.js';
import { loadConfig, type Config } from '../config.js';
import { ensureDefaultUser, openDatabase, type DB, type UserRow } from '../db.js';
import { ensureLocalUsers, LOCAL_USERS, seedDatabase, type SeedManifest, type SeedOptions } from './seed.js';
import type { ItemRow } from '../routes/shared.js';
import type { AuthMode } from '../../shared/api.js';
import { atTime } from '../../shared/dates.js';

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
  /**
   * Without `body` a write sends no body and no content type, as the web app sends pause,
   * resume, finish, cancel, end break and logout; app.ts then reads `req.body` as `{}`.
   * The same holds for put and patch.
   */
  post<T = any>(path: string, body?: unknown): Promise<ApiResponse<T>>;
  put<T = any>(path: string, body?: unknown): Promise<ApiResponse<T>>;
  patch<T = any>(path: string, body?: unknown): Promise<ApiResponse<T>>;
  del<T = any>(path: string): Promise<ApiResponse<T>>;
  /** A GET read as a server-sent event stream, as the web app's EventSource reads it. */
  stream(path: string): Promise<Stream>;
  /** Cookies this client is currently sending (name → value). */
  cookies(): Record<string, string>;
}

export interface Stream {
  status: number;
  headers: Headers;
  /** The next event: its text up to the blank line that ends it. Rejects with 'stream ended' once the server ends the answer. */
  next(): Promise<string>;
  /** Leaves, as a closed tab does. */
  close(): void;
}

export interface TestApp {
  db: DB;
  config: Config;
  url: string;
  /** The users' live streams, as the entrypoint shares them with `startBackgroundJobs`. */
  changes: ChangeFeed;
  /** Default client. In AUTH_MODE=none every request is the default user. */
  api: Client;
  /** A client with its own cookie jar, e.g. a second user. */
  client(): Client;
  /** Set when started with `seed`. */
  seeded?: SeedManifest;
  /** Rows in `table`, or those matching `where` (SQL, with `?` for each of `params`): `countRows` on this app's DB. */
  count(table: string, where?: string, ...params: unknown[]): number;
  /** The task with this uid as stored, a tombstone included. */
  item(uid: string): ItemRow | undefined;
  /** Saves a day's list on the default client as the web app does, with the list it was built on when given. */
  saveList(date: string, priorities: Record<string, unknown>[], base?: Record<string, unknown>[]): Promise<ApiResponse>;
  /** A task captured on the board on the default client, in `lane` before `before` there (null: the end). */
  capture(uid: string, title: string, lane: string, before?: string | null): Promise<ApiResponse>;
  /**
   * Under AUTH_MODE=local: the seed's two accounts, each signed in on a client of its own, for
   * the tests that check one user never sees or touches another's rows.
   */
  twoUsers(): Promise<{ admin: UserRow; member: UserRow; a: Client; b: Client }>;
  close(): Promise<void>;
}

export interface StartOptions {
  /**
   * `oidc` points discovery at a port nothing listens on: the routes that don't need the provider
   * can still be tested. Port 2, since fetch refuses 1 and 9 itself ("bad port") without connecting.
   */
  authMode?: AuthMode;
  /** Seed the default user (AUTH_MODE=none only); pass options to override the defaults. */
  seed?: boolean | Partial<Omit<SeedOptions, 'userId'>>;
  /** Extra environment for `loadConfig`, e.g. `{ RETENTION_DAYS: '30' }`. */
  env?: Record<string, string>;
  /** A directory to serve as the built client; by default nothing is served outside /api. */
  clientDir?: string;
  /** The OIDC lookup the app should use, as the entrypoint passes the one it warms; by default the app makes its own. */
  discovery?: Discovery;
}

/** Every test app's first-run setup code (AUTH_MODE=local), so a test can post it with the form. */
export const SETUP_CODE = 'TEST-SETU-PCOD';

/** The first local account's setup form, which makes it the admin. */
export const FIRST_RUN = { username: 'geran', password: 'correct horse', setupCode: SETUP_CODE };

/** A Wednesday, so "this week" in a review holds seeded days on both sides. */
export const SEED_TODAY = '2026-09-16';
export const SEED_NOW = atTime(SEED_TODAY, 14, 0);

/** Rows in `table`, or those matching `where` (SQL, with `?` for each of `params`). */
export function countRows(db: DB, table: string, where?: string, ...params: unknown[]): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}${where ? ` WHERE ${where}` : ''}`).get(...params) as { n: number }).n;
}

/**
 * Writes a stand-in for dist/client into `root`: the shell, a fingerprinted asset, an icon, the
 * manifest and the service worker. Pass the folder as `clientDir`.
 */
export function writeClientBuild(root: string): void {
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(root, 'icons'));
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>shell</title>');
  fs.writeFileSync(path.join(root, 'assets', 'index-abc123.js'), 'console.log(1)');
  fs.writeFileSync(path.join(root, 'icons', 'icon.svg'), '<svg/>');
  fs.writeFileSync(path.join(root, 'manifest.webmanifest'), '{}');
  fs.writeFileSync(path.join(root, 'sw.js'), '');
}

/** `writeClientBuild` in a new temporary folder, which the caller removes. */
export function tempClientBuild(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clockspan-client-'));
  writeClientBuild(dir);
  return dir;
}

function makeClient(baseUrl: string): Client {
  const jar = new Map<string, string>();
  const request = async <T>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (jar.size) headers.cookie = stringifyCookie(Object.fromEntries(jar));
    const res = await fetch(baseUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const raw of res.headers.getSetCookie()) {
      const c = parseSetCookie(raw);
      if (!c.value || c.maxAge === 0) jar.delete(c.name);
      else jar.set(c.name, c.value);
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
    post: (p, b) => request('POST', p, b),
    put: (p, b) => request('PUT', p, b),
    patch: (p, b) => request('PATCH', p, b),
    del: (p) => request('DELETE', p),
    stream: async (p) => {
      const leave = new AbortController();
      const headers = jar.size ? { cookie: stringifyCookie(Object.fromEntries(jar)) } : undefined;
      const res = await fetch(baseUrl + p, { headers, signal: leave.signal });
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
      let text = '';
      return {
        status: res.status,
        headers: res.headers,
        next: async () => {
          while (!text.includes('\n\n')) {
            const { done, value } = await reader.read();
            if (done) throw new Error('stream ended');
            text += value;
          }
          const end = text.indexOf('\n\n');
          const event = text.slice(0, end);
          text = text.slice(end + 2);
          return event;
        },
        close: () => leave.abort(),
      };
    },
    cookies: () => Object.fromEntries(jar),
  };
}

export async function startTestApp(opts: StartOptions = {}): Promise<TestApp> {
  const authMode = opts.authMode ?? 'none';
  const oidcEnv =
    authMode === 'oidc' ? { OIDC_ISSUER: 'https://127.0.0.1:2/', OIDC_CLIENT_ID: 'clockspan', OIDC_CLIENT_SECRET: 'secret', APP_URL: 'http://localhost' } : {};
  const config = loadConfig({ AUTH_MODE: authMode, ...oidcEnv, ...opts.env });
  const db = openDatabase(':memory:');
  // Before the server listens, so a refused seed leaves nothing open.
  let seeded: SeedManifest | undefined;
  if (opts.seed) {
    if (authMode !== 'none') {
      db.close();
      throw new Error('seed: true needs authMode "none"; under local auth create users first and call seedDatabase yourself.');
    }
    const user = ensureDefaultUser(db);
    const extra = typeof opts.seed === 'object' ? opts.seed : {};
    seeded = seedDatabase(db, { userId: user.id, today: SEED_TODAY, now: SEED_NOW, ...extra });
  }
  const changes = changeFeed();
  // No client dir means the static block stays off, so /api tests never see index.html.
  const app = createApp(db, config, {
    clientDir: opts.clientDir ?? path.join(os.tmpdir(), 'clockspan-no-client'),
    setupCode: SETUP_CODE,
    discovery: opts.discovery,
    changes,
  });
  const server = app.listen(0, '127.0.0.1');
  // Rejects on 'error': Express 5 hands a failed listen to the callback instead of throwing.
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  const api = makeClient(url);

  return {
    db,
    config,
    url,
    changes,
    api,
    client: () => makeClient(url),
    seeded,
    count: (table, where, ...params) => countRows(db, table, where, ...params),
    item: (uid) => db.prepare(`SELECT * FROM items WHERE uid = ?`).get(uid) as ItemRow | undefined,
    saveList: (date, priorities, base) => api.put(`/api/days/${date}/priorities`, base ? { priorities, base } : { priorities }),
    capture: (uid, title, lane, before = null) => api.post('/api/items', { uid, title, lane, before }),
    twoUsers: async () => {
      const users = await ensureLocalUsers(db);
      const signIn = async (username: string) => {
        const client = makeClient(url);
        const r = await client.post('/api/auth/login', { username, password: LOCAL_USERS.password });
        if (r.status !== 200) throw new Error(`${username} could not sign in (${r.status})`);
        return client;
      };
      return { ...users, a: await signIn(LOCAL_USERS.admin), b: await signIn(LOCAL_USERS.member) };
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          db.close();
          if (err) reject(err);
          else resolve();
        });
        // close() waits for every busy connection: an open stream never ends by itself, and after a
        // stream it aborted, fetch opens a spare that counts as busy until fetch drops it, 3 s on.
        server.closeAllConnections();
      }),
  };
}
