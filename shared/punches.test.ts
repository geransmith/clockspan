import { describe, expect, it } from 'vitest';
import type { Punch } from './api.js';
import { kindForPosition, mergePunches, punchesKey } from './punches.js';

describe('kindForPosition', () => {
  it('reads even rows as in and odd rows as out', () => {
    expect([0, 1, 2, 3, 4, 5].map(kindForPosition)).toEqual(['in', 'out', 'in', 'out', 'in', 'out']);
  });
});

const rows = (...at: (number | null)[]): Punch[] => at.map((t, position) => ({ position, kind: kindForPosition(position), at: t }));

describe('punchesKey', () => {
  it('matches two separate copies of the same rows', () => {
    expect(punchesKey(rows(1, null, null, 4))).toBe(punchesKey(rows(1, null, null, 4)));
  });

  it('tells apart a time changed, rows added, or the same times on other rows', () => {
    expect(punchesKey(rows(1, null, null, 4))).not.toBe(punchesKey(rows(1, null, null, 5)));
    expect(punchesKey(rows(1, null, null, 4))).not.toBe(punchesKey(rows(1, null, null, 4, null, null)));
    const moved = rows(1, 2, null, null).map((p) => ({ ...p, position: p.position + 1 }));
    expect(punchesKey(rows(1, 2, null, null))).not.toBe(punchesKey(moved));
  });
});

describe('mergePunches', () => {
  it("keeps a punch another device saved since the base, and this device's changes", () => {
    // The phone clocked out; the laptop, on the copy from before, set lunch in.
    expect(mergePunches(rows(1, 2, null, 9), rows(1, 2, null, null), rows(1, 2, 3, null))).toEqual(rows(1, 2, 3, 9));
  });

  it("takes this device's time over the stored one where both changed it, a clear included", () => {
    expect(mergePunches(rows(1, 2, null, 9), rows(1, 2, null, 8), rows(1, 2, null, null))).toEqual(rows(1, 2, null, null));
    expect(mergePunches(rows(5, null, null, null), rows(1, null, null, null), rows(4, null, null, null))).toEqual(rows(4, null, null, null));
  });

  it('leaves the list as sent with no base, or when a pair was added or removed on either side', () => {
    const list = rows(1, 2, 3, null);
    expect(mergePunches(rows(1, 2, null, 9), null, list)).toBe(list);
    expect(mergePunches(rows(1, 2, null, 9), rows(1, 2, null, null, null, null), list)).toBe(list);
    expect(mergePunches(rows(1, 2, null, 9, null, null), rows(1, 2, null, null), list)).toBe(list);
    expect(mergePunches([], rows(null, null, null, null), list)).toBe(list);
  });
});
