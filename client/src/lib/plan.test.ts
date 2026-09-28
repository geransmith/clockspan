import { describe, expect, it } from 'vitest';
import type { Priority } from '../types';
import { nextWorkDay, planNext } from './plan';
import { MAX_PRIORITIES } from './priorities';

const row = (position: number, text: string, patch: Partial<Priority> = {}): Priority => ({
  position,
  text,
  done: false,
  uid: `u${position}`,
  addedAt: 1,
  ...patch,
});

describe('nextWorkDay', () => {
  it('is the next day, or the next weekday when weekends are off the calendar', () => {
    expect(nextWorkDay('2026-09-24', true)).toBe('2026-09-25'); // Thu → Fri
    expect(nextWorkDay('2026-09-25', true)).toBe('2026-09-26'); // Fri → Sat
    expect(nextWorkDay('2026-09-25', false)).toBe('2026-09-28'); // Fri → Mon
    expect(nextWorkDay('2026-09-26', false)).toBe('2026-09-28'); // Sat → Mon
    expect(nextWorkDay('2026-09-24', false)).toBe('2026-09-25');
  });
});

describe('planNext', () => {
  it('adds after what the day holds, skipping text already there and empty rows', () => {
    const existing = [row(2, 'Call the bank'), row(1, ''), row(3, 'Ship it')];
    const { rows, added } = planNext(existing, ['ship  IT', 'Write the report', ' ', 'write the report'], 99);
    expect(added).toBe(1);
    expect(rows.map((p) => [p.position, p.text])).toEqual([
      [1, 'Call the bank'],
      [2, 'Ship it'],
      [3, 'Write the report'],
    ]);
    // The rows already there keep their identity; the new one gets its own, stamped now.
    expect(rows[0]!.uid).toBe('u2');
    expect(rows[2]).toMatchObject({ done: false, addedAt: 99 });
    expect(rows[2]!.uid).toMatch(/^[0-9a-f]{12}$/);
  });

  it('stops at the limit of rows a day can hold', () => {
    const full = Array.from({ length: MAX_PRIORITIES - 1 }, (_, i) => row(i + 1, `p${i}`));
    const { rows, added } = planNext(full, ['one more', 'and another'], 5);
    expect(added).toBe(1);
    expect(rows).toHaveLength(MAX_PRIORITIES);
  });
});
