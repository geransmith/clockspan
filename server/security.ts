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

export function securityHeaders(config: Config): RequestHandler {
  // HSTS only makes sense on https, and browsers ignore it on plain http anyway; tying it
  // to cookieSecure keeps one switch for "this deployment is https".
  const hsts = config.cookieSecure ? `max-age=${ONE_YEAR_SEC}` : null;
  return (_req, res, next) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (hsts) res.setHeader('Strict-Transport-Security', hsts);
    next();
  };
}
