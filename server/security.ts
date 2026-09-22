import type { RequestHandler } from 'express';
import type { Config } from './config.js';

/**
 * Response headers for every request. The app is a same-origin SPA with no third-party
 * assets, so the policy can be the strict default: scripts and styles only from this
 * origin, no framing, no plugins. `data:` images cover the SVG favicon and PWA icons.
 * Dev (Vite on :5173) never goes through here, so a CSP change is only visible against the
 * built bundle (the `prod` launch config).
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const ONE_YEAR_SEC = 31_536_000;

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Refuses an API write that the browser says another site sent. SameSite=Lax keeps the
 * session cookie off a cross-site POST, but under AUTH_MODE=none there is no cookie, and a
 * "simple" POST (a form, or fetch in no-cors mode) needs no preflight: any page the user
 * visits could finish or cancel their running timer. `same-site` is refused too, because a
 * sibling app on the same domain counts as same-site for the cookie. The app's own requests
 * are always same-origin. A request without the header (curl, Safari before 16.4) passes,
 * and SameSite is all that covers those browsers.
 */
export const rejectCrossSiteWrites: RequestHandler = (req, res, next) => {
  const site = req.get('sec-fetch-site');
  if (!READ_METHODS.has(req.method) && (site === 'cross-site' || site === 'same-site')) {
    res.status(403).json({ error: 'Cross-site request refused.' });
    return;
  }
  next();
};

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
    // their own caching in app.ts.
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  };
}
