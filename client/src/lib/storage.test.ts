import { afterEach, describe, expect, it, vi } from 'vitest';
import { readStored, writeStored } from './storage';

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
});
