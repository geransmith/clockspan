import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTH_USER_KEY, adoptUser, pruneStored, readStored, readStoredJson, writeStored } from './storage';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('stored values', () => {
  it('reads and writes through localStorage', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    expect(readStored('focus:x')).toBeNull();
    writeStored('focus:x', '1');
    expect(readStored('focus:x')).toBe('1');
  });

  it('reads nothing and keeps nothing when storage is blocked or missing', () => {
    const blocked = () => {
      throw new Error('SecurityError');
    };
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked });
    expect(readStored('focus:x')).toBeNull();
    expect(() => writeStored('focus:x', '1')).not.toThrow();
    vi.stubGlobal('localStorage', undefined);
    expect(readStored('focus:x')).toBeNull();
    expect(() => writeStored('focus:x', '1')).not.toThrow();
  });

  it('reads JSON, and null for nothing stored or a value that does not parse', () => {
    const store = new Map([
      ['focus:list', '["a","b"]'],
      ['focus:bad', '{nope'],
    ]);
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null });
    expect(readStoredJson('focus:list')).toEqual(['a', 'b']);
    expect(readStoredJson('focus:bad')).toBeNull();
    expect(readStoredJson('focus:none')).toBeNull();
  });

  it('prunes every key under a prefix but the one to keep, and nothing else', () => {
    const store = new Map([
      ['focus:alarms:2026-09-20', '[]'],
      ['focus:alarms:2026-09-21', '[]'],
      ['focus:alarms:2026-09-22', '["x"]'],
      ['focus:settingsTab', 'data'],
    ]);
    vi.stubGlobal('localStorage', {
      get length() {
        return store.size;
      },
      key: (i: number) => [...store.keys()][i] ?? null,
      removeItem: (k: string) => void store.delete(k),
    });
    pruneStored('focus:alarms:', 'focus:alarms:2026-09-22');
    expect([...store.keys()]).toEqual(['focus:alarms:2026-09-22', 'focus:settingsTab']);
  });

  it('prunes nothing, quietly, when storage is blocked', () => {
    vi.stubGlobal('localStorage', {
      get length(): number {
        throw new Error('SecurityError');
      },
    });
    expect(() => pruneStored('focus:alarms:', 'focus:alarms:2026-09-22')).not.toThrow();
  });
});

describe('adoptUser', () => {
  const DEVICE = { 'focus:theme': 'dark', 'focus:settingsTab': 'data', 'focus:timer-due': '7:1790000000000' };
  const USERS = { 'focus:alarms:2026-09-30': '["x"]', 'focus:left-open-dismissed': '2026-09-30' };

  /** A localStorage over a Map, holding the device's keys, one user's, and `focus:auth-user` when given. */
  function stored(user?: string): Map<string, string> {
    const store = new Map(Object.entries({ ...DEVICE, ...USERS }));
    if (user != null) store.set(AUTH_USER_KEY, user);
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      get length() {
        return store.size;
      },
      key: (i: number) => [...store.keys()][i] ?? null,
      removeItem: (k: string) => void store.delete(k),
    });
    return store;
  }

  it('records the first user and keeps their keys, and keeps them for the same user', () => {
    const store = stored();
    adoptUser(2);
    expect(store.get(AUTH_USER_KEY)).toBe('2');
    expect(Object.fromEntries(store)).toMatchObject({ ...DEVICE, ...USERS });
    adoptUser(2);
    expect(Object.fromEntries(store)).toEqual({ ...DEVICE, ...USERS, [AUTH_USER_KEY]: '2' });
  });

  it("drops the last user's keys for another user or no one, and keeps the device's", () => {
    const another = stored('2');
    adoptUser(3);
    expect(Object.fromEntries(another)).toEqual({ ...DEVICE, [AUTH_USER_KEY]: '3' });
    const signedOut = stored('2');
    adoptUser(null);
    expect(Object.fromEntries(signedOut)).toEqual({ ...DEVICE, [AUTH_USER_KEY]: '' });
  });

  it('drops nothing for a user signing in after no one', () => {
    const store = stored('');
    adoptUser(2);
    expect(Object.fromEntries(store)).toEqual({ ...DEVICE, ...USERS, [AUTH_USER_KEY]: '2' });
  });

  it('does nothing, quietly, when storage is blocked or missing', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => adoptUser(3)).not.toThrow();
  });
});
