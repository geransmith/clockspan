import { isIPv6 } from 'node:net';
import type { Response } from 'express';
import { MINUTE_MS } from '../../shared/dates.js';

/**
 * The sign-in limits: failures per address (an IPv6 client by its /64) and per account name.
 * The local auth router counts sign-ins, wrong setup codes and wrong current passwords here.
 */

const MAX_ATTEMPTS = 5;
/**
 * Failures one username may collect from all addresses together. The per-address limit alone
 * leaves an attacker who holds many addresses (a /48 is 65,536 of the /64s below) bounded only
 * by scrypt's speed. Set well above what typos add up to: someone locking an account on
 * purpose has to keep sending failures, and devices already signed in are not affected.
 */
export const MAX_ACCOUNT_FAILURES = 50;
const WINDOW_MS = 15 * MINUTE_MS;
// Expired entries are swept once the map grows past this, so a spray of addresses can't
// make it grow without bound.
const SWEEP_ABOVE = 1000;

/** Simple login limiter, per address or per account. In-memory is fine for a single-process self-hosted app. */
export class LoginLimiter {
  private attempts = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly maxAttempts = MAX_ATTEMPTS) {}

  check(ip: string): { ok: boolean; retryAfterSec: number } {
    const entry = this.attempts.get(ip);
    if (!entry || entry.resetAt <= Date.now()) return { ok: true, retryAfterSec: 0 };
    if (entry.count >= this.maxAttempts) {
      return { ok: false, retryAfterSec: Math.ceil((entry.resetAt - Date.now()) / 1000) };
    }
    return { ok: true, retryAfterSec: 0 };
  }

  fail(ip: string): void {
    const now = Date.now();
    if (this.attempts.size >= SWEEP_ABOVE) {
      for (const [k, v] of this.attempts) if (v.resetAt <= now) this.attempts.delete(k);
    }
    const entry = this.attempts.get(ip);
    if (!entry || entry.resetAt <= now) this.attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    else entry.count += 1;
  }

  /**
   * Takes back the attempt `fail` counted for a request that turned out to be right. The
   * failures before it stay: if a success cleared them, anyone with an account of their own
   * could sign in between guesses at someone else's password and never reach the limit.
   */
  succeed(ip: string): void {
    const entry = this.attempts.get(ip);
    if (entry) entry.count -= 1;
  }
}

/**
 * What the login limiter counts an address under. An IPv6 client is usually handed a whole
 * /64, so keyed by the full address it could take a fresh five attempts from each of 2^64
 * addresses; the /64 is the client. An IPv4 address a dual-stack socket reports as
 * `::ffff:a.b.c.d` is that IPv4 address.
 */
export function limiterKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (!isIPv6(ip)) return ip;
  const [head = '', tail] = ip.split('%')[0]!.split('::');
  // A dotted IPv4 tail fills the last two groups.
  const groups = (s: string) => (s ? s.split(':').flatMap((g) => (g.includes('.') ? ['0', '0'] : [g])) : []);
  const h = groups(head);
  const t = tail === undefined ? [] : groups(tail);
  const full = [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t];
  return `${full
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(':')}::/64`;
}

/**
 * What the per-account limit counts a sign-in under: the name as typed, whether or not it
 * exists (a limit only on real accounts would tell a guesser which names are real), matched
 * whatever its case like sign-in itself. Cut to the longest valid username so that one
 * address's five attempts can't park megabytes of made-up names in the limiter.
 */
export function accountKey(username: unknown): string {
  return typeof username === 'string' ? username.trim().toLowerCase().slice(0, 40) : '';
}

/** The 429 for a request the limiter holds back, with when to try again. */
export function refuseTooMany(res: Response, retryAfterSec: number): void {
  res.setHeader('Retry-After', String(retryAfterSec));
  res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(retryAfterSec / 60)} min.` });
}
