import path from 'node:path';

export type AuthMode = 'none' | 'local' | 'oidc';

export interface Config {
  port: number;
  dataDir: string;
  dbPath: string;
  authMode: AuthMode;
  appUrl: string | null;
  cookieSecure: boolean;
  trustProxy: boolean | number;
  sessionTtlMs: number;
  oidc: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    scopes: string;
  } | null;
}

function parseTrustProxy(raw: string | undefined): boolean | number {
  if (!raw || raw === 'false' || raw === '0') return false;
  if (raw === 'true') return true;
  const n = Number(raw);
  return Number.isFinite(n) ? n : true;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const authModeRaw = (env.AUTH_MODE ?? 'none').toLowerCase();
  if (!['none', 'local', 'oidc'].includes(authModeRaw)) {
    throw new Error(`AUTH_MODE must be one of none|local|oidc (got "${authModeRaw}")`);
  }
  const authMode = authModeRaw as AuthMode;

  const appUrl = env.APP_URL ? env.APP_URL.replace(/\/+$/, '') : null;
  const cookieSecure =
    env.COOKIE_SECURE !== undefined
      ? env.COOKIE_SECURE === 'true'
      : Boolean(appUrl && appUrl.startsWith('https://'));

  let oidc: Config['oidc'] = null;
  if (authMode === 'oidc') {
    const missing = ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'APP_URL'].filter(
      (k) => !env[k],
    );
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
  const ttlDays = Number(env.SESSION_TTL_DAYS ?? 30);

  return {
    port: Number(env.PORT ?? 3000),
    dataDir,
    dbPath: path.join(dataDir, 'focus.db'),
    authMode,
    appUrl,
    cookieSecure,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    sessionTtlMs: (Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays : 30) * 86_400_000,
    oidc,
  };
}
