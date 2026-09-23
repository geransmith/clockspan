import { afterEach, describe, expect, it, vi } from 'vitest';
import { pruneStored, readStored, readStoredJson, writeStored } from './storage';

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
