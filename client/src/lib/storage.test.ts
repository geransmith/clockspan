import { describe, expect, it, vi } from 'vitest';
import { addToDaySet, AUTH_USER_KEY, adoptUser, otherUserStored, pruneStored, readDaySet, readStored, writeStored } from './storage';

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

  it("keeps a day's set under one key and reads it back for that day only", () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    expect(readDaySet('focus:set', '2026-09-28')).toEqual(new Set());
    expect(addToDaySet('focus:set', '2026-09-28', ['a', 'b', 'a'])).toEqual(new Set(['a', 'b']));
    expect(store.get('focus:set')).toBe('2026-09-28 a,b');
    // What another tab stored meanwhile stays.
    store.set('focus:set', '2026-09-28 a,c');
    expect(addToDaySet('focus:set', '2026-09-28', ['d'])).toEqual(new Set(['a', 'c', 'd']));
    expect(readDaySet('focus:set', '2026-09-28')).toEqual(new Set(['a', 'c', 'd']));
    // Another day starts with none, and its first add drops the day before's.
    expect(readDaySet('focus:set', '2026-09-29')).toEqual(new Set());
    expect(addToDaySet('focus:set', '2026-09-29', ['e'])).toEqual(new Set(['e']));
    expect(store.get('focus:set')).toBe('2026-09-29 e');
  });

  it('reads an empty set from anything else stored', () => {
    const store = new Map([
      ['focus:date-only', '2026-09-28'],
      ['focus:empty', '2026-09-28 '],
      ['focus:prefixed', 'x2026-09-28 a'],
      ['focus:json', '["a"]'],
    ]);
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null });
    for (const key of store.keys()) expect(readDaySet(key, '2026-09-28')).toEqual(new Set());
  });

  it('prunes every key under a prefix, and nothing else', () => {
    const store = new Map([
      ['focus:alarms', '2026-09-22 x'],
      ['focus:alarms:2026-09-21', '[]'],
      ['focus:settingsTab', 'data'],
    ]);
    vi.stubGlobal('localStorage', {
      get length() {
        return store.size;
      },
      key: (i: number) => [...store.keys()][i] ?? null,
      removeItem: (k: string) => void store.delete(k),
    });
    pruneStored('focus:alarms');
    expect([...store.keys()]).toEqual(['focus:settingsTab']);
  });

  it('prunes nothing, quietly, when storage is blocked', () => {
    vi.stubGlobal('localStorage', {
      get length(): number {
        throw new Error('SecurityError');
      },
    });
    expect(() => pruneStored('focus:alarms')).not.toThrow();
  });
});

describe('adoptUser and otherUserStored', () => {
  const DEVICE = { 'focus:theme': 'dark', 'focus:settingsTab': 'data', 'focus:timer-due': '7:1790000000000' };
  const USERS = {
    'focus:alarms': '2026-09-30 lunchBy:lead:15:29833440',
    // Left by a version that kept a key per day.
    'focus:alarms:2026-09-29': '["x"]',
    'focus:left-open-dismissed': '2026-09-30',
    'focus:break-over': '1790000000000',
    'focus:capture-category': 'cafe00000001',
    'focus:recurring-answered': '2026-09-30 rcur00000001',
  };

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

  it('drops what a page left open after a sign-out wrote, for a user signing in after no one', () => {
    const store = stored('');
    adoptUser(2);
    expect(Object.fromEntries(store)).toEqual({ ...DEVICE, [AUTH_USER_KEY]: '2' });
  });

  it('does nothing, quietly, when storage is blocked or missing', () => {
    const blocked = () => {
      throw new Error('SecurityError');
    };
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked });
    expect(() => adoptUser(3)).not.toThrow();
    vi.stubGlobal('localStorage', undefined);
    expect(() => adoptUser(3)).not.toThrow();
  });

  it('tells whether the stored user is someone other than the one given, in the form adoptUser writes', () => {
    stored();
    expect(otherUserStored(2)).toBe(false);
    adoptUser(2);
    expect(otherUserStored(2)).toBe(false);
    expect(otherUserStored(3)).toBe(true);
    expect(otherUserStored(null)).toBe(true);
    adoptUser(null);
    expect(otherUserStored(null)).toBe(false);
    expect(otherUserStored(2)).toBe(true);
  });
});
