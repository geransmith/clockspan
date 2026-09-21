import { describe, expect, it } from 'vitest';
import { DUMMY_HASH, hashPassword, validatePassword, validateUsername, verifyPassword } from './password.js';

describe('hashPassword / verifyPassword', () => {
  it('round-trips at the default cost and rejects a wrong password', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(stored.startsWith('scrypt$15$')).toBe(true);
    expect(await verifyPassword('correct horse battery', stored)).toBe(true);
    expect(await verifyPassword('correct horse batter', stored)).toBe(false);
  });

  it('verifies hashes written at another cost, so LOG2_N can be raised without invalidating rows', async () => {
    // 2^18 needs 268 MB, which a fixed 256 MB maxmem used to reject with an exception.
    for (const log2N of [12, 18]) {
      const stored = await hashPassword('pw-at-other-cost', log2N);
      expect(stored.startsWith(`scrypt$${log2N}$`)).toBe(true);
      expect(await verifyPassword('pw-at-other-cost', stored)).toBe(true);
      expect(await verifyPassword('nope', stored)).toBe(false);
    }
  }, 20_000);

  it('answers false, never throws, for malformed or out-of-range stored values', async () => {
    const good = await hashPassword('anything');
    const [, , salt, hash] = good.split('$');
    for (const bad of [
      '',
      'plain',
      'bcrypt$10$x$y',
      `scrypt$9$${salt}$${hash}`,
      `scrypt$21$${salt}$${hash}`,
      `scrypt$abc$${salt}$${hash}`,
      `scrypt$15$$${hash}`,
      `scrypt$15$${salt}$`,
    ]) {
      expect(await verifyPassword('anything', bad)).toBe(false);
    }
  });

  it('DUMMY_HASH is a real hash that matches nothing a user would send', async () => {
    expect(DUMMY_HASH.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('', DUMMY_HASH)).toBe(false);
    expect(await verifyPassword('password', DUMMY_HASH)).toBe(false);
  });
});

describe('validation', () => {
  it('bounds passwords and usernames', () => {
    expect(validatePassword(undefined)).toMatch(/required/);
    expect(validatePassword('short')).toMatch(/at least 8/);
    expect(validatePassword('x'.repeat(201))).toMatch(/too long/);
    expect(validatePassword('long enough')).toBeNull();
    expect(validateUsername(5)).toMatch(/required/);
    expect(validateUsername('a')).toMatch(/at least 2/);
    expect(validateUsername('a'.repeat(41))).toMatch(/40 characters/);
    expect(validateUsername('no spaces')).toMatch(/may contain/);
    expect(validateUsername(' sam.smith-1_ ')).toBeNull();
  });
});
