import { isIP } from 'node:net';
import type { RequestHandler } from 'express';
import type { Config } from './config.js';
import { refuse } from './refuse.js';

/**
 * Response headers for every request. The app is a same-origin SPA with no third-party
 * assets, so the policy can be the strict default: same-origin only, no framing, no plugins.
 * `default-src 'self'` covers every fetch directive (scripts, styles, images, fetches, the
 * manifest, the service worker); the others listed are the directives that don't fall back to
 * it, plus `object-src 'none'`, which is stricter.
 * The icons are files under /icons, and the build never inlines an asset as a `data:` URL
 * (`assetsInlineLimit` in vite.config.ts), so no directive needs `data:`.
 * Dev (Vite on :5173) never goes through here, so a CSP change is only visible against the
 * built bundle (the `prod` launch config).
 */
const CSP = ["default-src 'self'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'"].join('; ');

const ONE_YEAR_SEC = 31_536_000;

const API_PATH = /^\/api(?:\/|$)/i;

/** The methods that change nothing: rejectCrossSiteWrites lets them through, and app.ts reads the revision for them instead of moving it on. */
export const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Refuses an API write that the browser says another site sent. SameSite=Lax keeps the
 * session cookie off a cross-site POST, but under AUTH_MODE=none there is no cookie, and a
 * "simple" POST (a form, or fetch in no-cors mode) needs no preflight: any page the user
 * visits could finish or cancel their running timer. `same-site` is refused too, because a
 * sibling app on the same domain counts as same-site for the cookie. The app's own requests
 * are always same-origin. A browser without Sec-Fetch-Site (Safari before 16.4) still sends
 * Origin on a write, so then the Origin's host must be this host: the Host header, or
 * APP_URL's for a proxy that rewrites Host. `null` (a sandboxed frame) is never this host. A
 * request with neither header is not a browser acting for someone (curl) and passes.
 * What this can't see is DNS rebinding: a page that points one of its own names at this server
 * is same-origin to the browser. Under AUTH_MODE=none `rejectUnknownHosts` stops that; with
 * sign-in, the session cookie stays with the real host.
 */
export function rejectCrossSiteWrites(config: Config): RequestHandler {
  const appHost = config.appUrl ? new URL(config.appUrl).host : null;
  const foreign = (origin: string, host: string | undefined): boolean => {
    const from = URL.parse(origin)?.host;
    return from === undefined || (from !== host && from !== appHost);
  };
  return (req, res, next) => {
    if (!READ_METHODS.has(req.method)) {
      const site = req.get('sec-fetch-site');
      const origin = req.get('origin');
      const crossSite = site ? site === 'cross-site' || site === 'same-site' : origin !== undefined && foreign(origin, req.get('host'));
      if (crossSite) return refuse(res, 403, 'Cross-site request refused.');
    }
    next();
  };
}

/**
 * Top-level names that can't be registered on the internet (RFC 6761, RFC 6762, RFC 8375, and
 * `.internal`, which ICANN set aside in 2024), so no outside page can point one at this server.
 */
const PRIVATE_DOMAINS = ['.localhost', '.local', '.home.arpa', '.internal'];

/** How many refused names get a log line, so a stream of made-up names can't flood the log or grow the set. */
const REPORTED_NAMES = 10;

/** A Host header as a browser sends it: a bracketed IPv6 address or a name, then maybe a port. */
const HOST_HEADER = /^(?:\[([0-9a-f:.]+)\]|([a-z0-9_][a-z0-9_.-]*))(?::\d+)?$/i;

/** The name a Host header asks for, lowercased, with no port, brackets or trailing dot; null for a malformed header. */
function hostName(header: string): string | null {
  const m = HOST_HEADER.exec(header);
  if (!m) return null;
  if (m[1] !== undefined) return isIP(m[1]) === 6 ? m[1].toLowerCase() : null;
  return m[2]!.toLowerCase().replace(/\.$/, '');
}

/** An entry is one name, or with a leading dot a domain and every name under it. */
function matches(name: string, entry: string): boolean {
  return entry.startsWith('.') ? name === entry.slice(1) || name.endsWith(entry) : name === entry;
}

/**
 * Refuses an API request for a host name this server doesn't know. Mounted under AUTH_MODE=none
 * only (app.ts), where no cookie is needed: DNS rebinding points a name the attacker owns at
 * this server, the browser then treats the attacker's page as same-origin, and it can read and
 * write everything (`rejectCrossSiteWrites` sees `same-origin`). The request still names the
 * attacker's domain in Host, so an allowlist ends it. What always passes is what no outside
 * page can use: an IP address, a one-word name (`tower`, resolved on the LAN), and the names in
 * PRIVATE_DOMAINS. APP_URL's host and ALLOWED_HOSTS add the rest. Under sign-in the check isn't
 * needed: the session cookie never goes to the attacker's name.
 * The raw Host header is read, never `req.hostname`: behind TRUST_PROXY that believes
 * X-Forwarded-Host, which a same-origin page may set on its own requests.
 */
export function rejectUnknownHosts(config: Config): RequestHandler {
  const allowed = [...PRIVATE_DOMAINS, ...config.allowedHosts];
  if (config.appUrl) allowed.push(new URL(config.appUrl).hostname);
  const known = (name: string) => isIP(name) !== 0 || !name.includes('.') || allowed.some((entry) => matches(name, entry));
  const reported = new Set<string>();
  return (req, res, next) => {
    const header = req.get('host');
    // HTTP/1.0 without a Host header: not a browser, so not a page acting for someone.
    if (header === undefined) {
      next();
      return;
    }
    const name = hostName(header);
    if (name !== null && known(name)) {
      next();
      return;
    }
    if (name !== null && !reported.has(name) && reported.size < REPORTED_NAMES) {
      reported.add(name);
      console.warn(
        `[host] API request for ${JSON.stringify(name)} refused: with AUTH_MODE=none the API only answers names it knows. If the name is yours, add it to ALLOWED_HOSTS.`,
      );
    }
    refuse(res, 403, name === null ? 'Invalid Host header.' : `This server does not answer to ${name}. Add it to ALLOWED_HOSTS.`);
  };
}

export function securityHeaders(config: Config): RequestHandler {
  // HSTS only makes sense on https, and browsers ignore it on plain http anyway; tying it
  // to cookieSecure keeps one switch for "this deployment is https".
  const hsts = config.cookieSecure ? `max-age=${ONE_YEAR_SEC}` : null;
  return (req, res, next) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (hsts) res.setHeader('Strict-Transport-Security', hsts);
    // Every API answer is per-user JSON. Express adds an ETag and nothing else, so without
    // this a browser or a cache in front of the app could keep one; the static files set
    // their own caching in app.ts. Express mounts `/api` case-insensitively and with or
    // without a trailing slash, so `/API/settings` reaches the data routers and is marked too.
    if (API_PATH.test(req.path)) res.setHeader('Cache-Control', 'no-store');
    next();
  };
}
