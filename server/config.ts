import path from 'node:path';
import { MAX_RETENTION_DAYS, MIN_RETENTION_DAYS } from '../shared/settings.js';

export type AuthMode = 'none' | 'local' | 'oidc';

export interface Config {
  port: number;
  dataDir: string;
  dbPath: string;
  authMode: AuthMode;
  appUrl: string | null;
  cookieSecure: boolean;
  /** Express's `trust proxy` value: a hop count, or one of its string forms (`loopback`, an IP, a CIDR list). */
  trustProxy: boolean | number | string;
  sessionTtlMs: number;
  /** Server-wide ceiling on how many days of history any user keeps; null = no ceiling. */
  retentionDays: number | null;
  oidc: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    scopes: string;
  } | null;
}

/**
 * A hop count is the documented form. Express also takes `loopback`, an IP or a CIDR list as
 * a string, so those pass through untouched: turning an unknown string into `true` would
 * trust whatever X-Forwarded-For a client sends, which is exactly what the docs warn against.
 */
function parseTrustProxy(raw: string | undefined): boolean | number | string {
  if (!raw || raw === 'false' || raw === '0') return false;
  if (raw === 'true') return true;
  const n = Number(raw);
  return Number.isFinite(n) ? n : raw;
}

function parsePort(raw: string | undefined): number {
  if (!raw) return 3000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
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

export function loadConfig(rawEnv: NodeJS.ProcessEnv = process.env): Config {
  // Blank means unset. Unraid passes every template field, empty ones included (-e 'NAME'=''),
  // and so does a compose .env line like `COOKIE_SECURE=`; left in, '' would beat the defaults.
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(rawEnv).filter(([, value]) => value !== ''));
  const authModeRaw = (env.AUTH_MODE ?? 'none').toLowerCase();
  if (!['none', 'local', 'oidc'].includes(authModeRaw)) {
    throw new Error(`AUTH_MODE must be one of none|local|oidc (got "${authModeRaw}")`);
  }
  const authMode = authModeRaw as AuthMode;

  const appUrl = env.APP_URL ? env.APP_URL.replace(/\/+$/, '') : null;
  const cookieSecure = env.COOKIE_SECURE !== undefined ? env.COOKIE_SECURE === 'true' : Boolean(appUrl && appUrl.startsWith('https://'));

  let oidc: Config['oidc'] = null;
  if (authMode === 'oidc') {
    const missing = ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'APP_URL'].filter((k) => !env[k]);
    if (missing.length) {
      throw new Error(
        `AUTH_MODE=oidc requires ${missing.join(', ')}. ` +
          `APP_URL is the public URL of this app; the redirect URI registered in your ` +
          `provider must be \${APP_URL}/auth/callback.`,
      );
    }
    oidc = {
      issuer: env.OIDC_ISSUER!,
      clientId: env.OIDC_CLIENT_ID!,
      clientSecret: env.OIDC_CLIENT_SECRET!,
      scopes: env.OIDC_SCOPES ?? 'openid profile email',
    };
  }

  const dataDir = path.resolve(env.DATA_DIR ?? './data');

  let retentionDays: number | null = null;
  if (env.RETENTION_DAYS) {
    const n = Number(env.RETENTION_DAYS);
    if (!Number.isInteger(n) || n < MIN_RETENTION_DAYS || n > MAX_RETENTION_DAYS) {
      throw new Error(
        `RETENTION_DAYS must be a whole number of days from ${MIN_RETENTION_DAYS} to ${MAX_RETENTION_DAYS}, or unset to keep everything (got "${env.RETENTION_DAYS}")`,
      );
    }
    retentionDays = n;
  }

  return {
    port: parsePort(env.PORT),
    dataDir,
    dbPath: path.join(dataDir, 'focus.db'),
    authMode,
    appUrl,
    cookieSecure,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    sessionTtlMs: parseSessionTtlDays(env.SESSION_TTL_DAYS) * 86_400_000,
    retentionDays,
    oidc,
  };
}
