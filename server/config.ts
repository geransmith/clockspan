import { isIP } from 'node:net';
import path from 'node:path';
import { AUTH_MODES, type AuthMode } from '../shared/api.js';
import { DAY_MS } from '../shared/dates.js';
import { RETENTION_LIMITS } from '../shared/settings.js';
import { isOneOf, isWholeNumber } from './validate.js';

export interface Config {
  port: number;
  dbPath: string;
  authMode: AuthMode;
  appUrl: string | null;
  cookieSecure: boolean;
  /** Express's `trust proxy` value: a hop count, or one of its string forms (`loopback`, an IP, a CIDR list). */
  trustProxy: boolean | number | string;
  sessionTtlMs: number;
  /** Under AUTH_MODE=none, host names the API answers to beyond the ones that always pass (`rejectUnknownHosts`); a leading dot takes a whole domain. */
  allowedHosts: string[];
  /** Server-wide ceiling on how many days of history any user keeps; null = no ceiling. */
  retentionDays: number | null;
  oidc: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    scopes: string;
  } | null;
}

/** Express's names for address ranges in a `trust proxy` list. */
const PROXY_RANGES = new Set(['loopback', 'linklocal', 'uniquelocal']);

/** One entry of a `trust proxy` list: a range name, an IP address, or an address with a /prefix or /netmask. */
function isProxyEntry(entry: string): boolean {
  if (PROXY_RANGES.has(entry)) return true;
  const [ip, mask, ...rest] = entry.split('/') as [string, ...string[]];
  const family = isIP(ip);
  if (family === 0 || rest.length > 0) return false;
  if (mask === undefined) return true;
  if (/^\d+$/.test(mask)) return Number(mask) <= (family === 4 ? 32 : 128);
  return isIP(mask) === family;
}

/**
 * A hop count is the documented form. Express also takes `loopback`, an IP or a CIDR list as
 * a string, so those pass through untouched: turning an unknown string into `true` would
 * trust whatever X-Forwarded-For a client sends, which is exactly what the docs warn against.
 * Anything else is refused here. Express would take `1.5` as two hops and fail to start on
 * `yes` with a message that never names the variable. Spaces around the value are dropped,
 * so a hand-edited .env line or a pasted template field (`1 `) keeps working.
 */
function parseTrustProxy(raw: string | undefined): boolean | number | string {
  const value = raw?.trim();
  if (!value || value === 'false' || value === '0') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  if (value.split(',').every((entry) => isProxyEntry(entry.trim()))) return value;
  throw new Error(
    `TRUST_PROXY must be the number of proxies in front of the app (usually 1), or loopback, linklocal, uniquelocal, IP addresses or CIDR ranges separated by commas (got "${raw}")`,
  );
}

const TRUE_WORDS = new Set(['true', '1', 'yes', 'on']);
const FALSE_WORDS = new Set(['false', '0', 'no', 'off']);

/**
 * An on/off variable, in any of the usual spellings and any case, so `COOKIE_SECURE=TRUE`
 * turns the Secure flag on rather than off. A value that is neither is not
 * worth refusing to start over: it is logged and the default stands.
 */
function parseSwitch(name: string, raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const word = raw.trim().toLowerCase();
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  console.warn(`[config] ${name} should be true or false; "${raw}" is neither, so the default applies`);
  return undefined;
}

function parsePort(raw: string | undefined): number {
  if (!raw) return 3000;
  const n = Number(raw);
  if (!isWholeNumber(n, { min: 0, max: 65535 })) {
    throw new Error(`PORT must be a whole number from 0 to 65535 (got "${raw}")`);
  }
  return n;
}

function parseSessionTtlDays(raw: string | undefined): number {
  if (!raw) return 30;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`SESSION_TTL_DAYS must be a positive number of days (got "${raw}")`);
  }
  return n;
}

/** The server-wide ceiling on the days of history any user keeps; unset keeps everything. */
function parseRetentionDays(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!isWholeNumber(n, RETENTION_LIMITS)) {
    throw new Error(
      `RETENTION_DAYS must be a whole number of days from ${RETENTION_LIMITS.min} to ${RETENTION_LIMITS.max}, or unset to keep everything (got "${raw}")`,
    );
  }
  return n;
}

/**
 * Names only. The check compares the name in the Host header, so a scheme, port or path in an
 * entry (`https://focus.example.com`) would match nothing and leave the owner locked out with
 * no clue why; refuse it here instead. `*.example.com` is refused too: the leading dot is the
 * one form, and it takes the bare domain as well.
 */
function parseAllowedHosts(raw: string | undefined): string[] {
  if (!raw) return [];
  const entries = raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');
  for (const entry of entries) {
    if (!/^\.?[a-z0-9_-]+(\.[a-z0-9_-]+)*$/.test(entry)) {
      throw new Error(
        `ALLOWED_HOSTS must be host names separated by commas, like focus.example.com, or .example.com for a domain and every name under it (got "${entry}")`,
      );
    }
  }
  return entries;
}

/**
 * Both URLs reach `new URL()` later: APP_URL in the write guard, OIDC_ISSUER in discovery. A
 * value without a scheme (`focus.example.com`) would crash the first with a bare "Invalid URL"
 * and keep the second retrying forever, neither naming the variable. Refuse it here instead.
 */
function parseHttpUrl(name: string, what: string, raw: string, schemes: readonly string[] = ['https:', 'http:']): URL {
  const url = URL.parse(raw);
  if (!url || !schemes.includes(url.protocol)) {
    throw new Error(`${name} must be ${what}, starting with ${schemes.map((s) => `${s}//`).join(' or ')} (got "${raw}")`);
  }
  return url;
}

export function loadConfig(rawEnv: NodeJS.ProcessEnv = process.env): Config {
  // Blank means unset. Unraid passes every template field, empty ones included (-e 'NAME'=''),
  // and so does a compose .env line like `COOKIE_SECURE=`; left in, '' would beat the defaults.
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(rawEnv).filter(([, value]) => value !== ''));
  const authMode = (env.AUTH_MODE ?? 'none').toLowerCase();
  if (!isOneOf(AUTH_MODES, authMode)) throw new Error(`AUTH_MODE must be one of ${AUTH_MODES.join('|')} (got "${authMode}")`);

  // The scheme and host are case-insensitive, but the OIDC redirect URI is compared exactly as
  // a string, so the value is kept in the form a browser uses, lowercase. Only the origin is
  // kept, because the app runs at the root of its host: the client is built for it (no Vite
  // `base`), and the OIDC callback rebuilds its URL on APP_URL's origin, so a path in the
  // redirect URI would never match the one the callback sends.
  const publicUrl = env.APP_URL ? parseHttpUrl('APP_URL', 'the scheme and host the app is served at', env.APP_URL) : null;
  const appUrl = publicUrl?.origin ?? null;
  if (publicUrl && publicUrl.href !== `${appUrl}/`) {
    console.warn(
      `[config] APP_URL should be only the scheme and host the app is served at; "${env.APP_URL}" has more, so ${appUrl} is used (the app runs at the root of its host)`,
    );
  }
  const cookieSecure = parseSwitch('COOKIE_SECURE', env.COOKIE_SECURE) ?? publicUrl?.protocol === 'https:';

  let oidc: Config['oidc'] = null;
  if (authMode === 'oidc') {
    const missing = ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'APP_URL'].filter((k) => !env[k]);
    if (missing.length) {
      throw new Error(
        `AUTH_MODE=oidc requires ${missing.join(', ')}. ` +
          `APP_URL is the scheme and host this app is served at; the redirect URI registered in your ` +
          `provider must be \${APP_URL}/auth/callback.`,
      );
    }
    // Checked, not rewritten: the issuer is an identifier the provider's tokens must match as written.
    // https only: openid-client refuses every plain-http request, so an http issuer would boot and
    // then fail each discovery, logging a provider that looked down when it was never asked.
    parseHttpUrl('OIDC_ISSUER', "your provider's issuer URL", env.OIDC_ISSUER!, ['https:']);
    oidc = {
      issuer: env.OIDC_ISSUER!,
      clientId: env.OIDC_CLIENT_ID!,
      clientSecret: env.OIDC_CLIENT_SECRET!,
      scopes: env.OIDC_SCOPES ?? 'openid profile email',
    };
  }

  return {
    port: parsePort(env.PORT),
    dbPath: path.resolve(env.DATA_DIR ?? './data', 'focus.db'),
    authMode,
    appUrl,
    cookieSecure,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    sessionTtlMs: parseSessionTtlDays(env.SESSION_TTL_DAYS) * DAY_MS,
    allowedHosts: parseAllowedHosts(env.ALLOWED_HOSTS),
    retentionDays: parseRetentionDays(env.RETENTION_DAYS),
    oidc,
  };
}
