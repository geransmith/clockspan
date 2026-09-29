import { describe, expect, it } from 'vitest';
import { USERNAME } from '../../shared/api.js';
import { DUMMY_HASH, hashPassword, parseCredentials, parsePassword, parseUsername, verifyPassword } from './password.js';

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
    expect(parsePassword(undefined)).toEqual({ error: 'Password is required.' });
    expect(parsePassword('short')).toEqual({ error: expect.stringMatching(/at least 8/) });
    expect(parsePassword('x'.repeat(201))).toEqual({ error: expect.stringMatching(/too long/) });
    expect(parsePassword('long enough')).toEqual({ password: 'long enough' });
    expect(parseUsername(5)).toEqual({ error: 'Username is required.' });
    expect(parseUsername('a')).toEqual({ error: expect.stringMatching(/at least 2/) });
    expect(parseUsername('a'.repeat(41))).toEqual({ error: expect.stringMatching(/40 characters/) });
    expect(parseUsername('no spaces')).toEqual({ error: expect.stringMatching(/may contain/) });
    expect(parseUsername(' sam.smith-1_ ')).toEqual({ username: 'sam.smith-1_' });
  });

  it("gives the username inputs the server's rule, in a form browsers compile", () => {
    // A browser matches `pattern` against the input's whole value, with the v flag.
    const input = new RegExp(`^(?:${USERNAME.pattern})$`, 'v');
    for (const name of ['sam', 'sam.smith-1_', ' sam ']) {
      expect(input.test(name)).toBe(true);
      expect(parseUsername(name)).toEqual({ username: name.trim() });
    }
    for (const name of ['no spaces', 'sam!', 'sâm']) {
      expect(input.test(name)).toBe(false);
      expect(parseUsername(name)).toEqual({ error: 'Username may contain letters, numbers, . _ and -' });
    }
  });

  it('reads a new account from a request body, username first', () => {
    expect(parseCredentials({ username: ' sam ', password: 'long enough' })).toEqual({ username: 'sam', password: 'long enough' });
    expect(parseCredentials(undefined)).toEqual({ error: 'Username is required.' });
    expect(parseCredentials({ username: 'x', password: 'short' })).toEqual({ error: expect.stringMatching(/at least 2/) });
    expect(parseCredentials({ username: 'sam', password: 5 })).toEqual({ error: 'Password is required.' });
  });
});
