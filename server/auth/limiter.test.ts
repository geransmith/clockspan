import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountKey, LoginLimiter, limiterKey, MAX_ACCOUNT_FAILURES } from './limiter.js';

describe('LoginLimiter', () => {
  afterEach(() => vi.useRealTimers());

  it('locks an address after five failures for fifteen minutes, and a success takes back only its own attempt', () => {
    vi.useFakeTimers();
    const limiter = new LoginLimiter();
    for (let i = 0; i < 4; i++) limiter.fail('a');
    expect(limiter.check('a')).toEqual({ ok: true, retryAfterSec: 0 });
    limiter.fail('a');
    expect(limiter.check('a')).toEqual({ ok: false, retryAfterSec: 15 * 60 });
    vi.advanceTimersByTime(14 * 60_000);
    expect(limiter.check('a')).toEqual({ ok: false, retryAfterSec: 60 });
    vi.advanceTimersByTime(60_000);
    expect(limiter.check('a')).toEqual({ ok: true, retryAfterSec: 0 });
    // A failure after the window starts a fresh count rather than adding to the stale one.
    limiter.fail('a');
    expect(limiter.check('a').ok).toBe(true);
    // Three more failures, then the right password: counted like any attempt, then taken back.
    for (let i = 0; i < 3; i++) limiter.fail('a');
    limiter.fail('a');
    limiter.succeed('a');
    expect(limiter.check('a').ok).toBe(true);
    limiter.fail('a');
    expect(limiter.check('a').ok).toBe(false);
    // An address the limiter never saw, or has swept, has nothing to take back.
    limiter.succeed('b');
    expect(limiter.check('b')).toEqual({ ok: true, retryAfterSec: 0 });
  });

  it('takes its own limit, as the per-account one does', () => {
    const limiter = new LoginLimiter(MAX_ACCOUNT_FAILURES);
    for (let i = 0; i < MAX_ACCOUNT_FAILURES - 1; i++) limiter.fail('sam');
    expect(limiter.check('sam').ok).toBe(true);
    limiter.fail('sam');
    expect(limiter.check('sam').ok).toBe(false);
  });

  it('sweeps expired entries once the map grows past a thousand addresses', () => {
    vi.useFakeTimers();
    const limiter = new LoginLimiter();
    const size = () => (limiter as unknown as { attempts: Map<string, unknown> }).attempts.size;
    for (let i = 0; i < 1000; i++) limiter.fail(`10.0.${Math.floor(i / 256)}.${i % 256}`);
    expect(size()).toBe(1000);
    // Still within the window: nothing to sweep, the map keeps growing.
    limiter.fail('fresh');
    expect(size()).toBe(1001);
    vi.advanceTimersByTime(15 * 60_000);
    limiter.fail('after');
    expect(size()).toBe(1);
  });
});

describe('accountKey', () => {
  it('counts a name whatever its case or spacing, cut to the longest valid username', () => {
    expect(accountKey(' Sam ')).toBe('sam');
    expect(accountKey('x'.repeat(100))).toBe('x'.repeat(40));
    expect(accountKey(42)).toBe('');
  });
});

describe('limiterKey', () => {
  it('keeps IPv4 as is, unwraps a mapped IPv4, and cuts IPv6 to its /64', () => {
    expect(limiterKey('203.0.113.9')).toBe('203.0.113.9');
    expect(limiterKey('::FFFF:203.0.113.9')).toBe('203.0.113.9');
    expect(limiterKey('2001:0db8:0001:0002:0003:0004:0005:0006')).toBe('2001:db8:1:2::/64');
    expect(limiterKey('2001:db8:1:2::7')).toBe('2001:db8:1:2::/64');
    expect(limiterKey('2001:db8::')).toBe('2001:db8:0:0::/64');
    expect(limiterKey('::1')).toBe('0:0:0:0::/64');
    expect(limiterKey('::5:6:7:8:9:a:b')).toBe('0:5:6:7::/64');
    expect(limiterKey('64:ff9b::192.0.2.1')).toBe('64:ff9b:0:0::/64');
    expect(limiterKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(limiterKey('not an address')).toBe('not an address');
  });
});
