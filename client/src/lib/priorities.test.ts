import { describe, expect, it } from 'vitest';
import { COMPLETE_WARNINGS, GENTLE_WARNINGS, PROGRESS_WARNINGS } from './copy';
import { MAX_PRIORITIES, newUid, padPriorities, pickWarning, placePriority, warnThreshold, warningKind } from './priorities';
import type { Priority } from '../types';

const row = (position: number, text: string, extra: Partial<Priority> = {}): Priority => ({ position, text, done: false, uid: null, addedAt: null, ...extra });

describe('padPriorities', () => {
  it('fills a fresh day up to the configured count', () => {
    expect(padPriorities([], 3)).toEqual([row(1, ''), row(2, ''), row(3, '')]);
  });

  it('keeps stored rows in place and pads the rest', () => {
    const rows = padPriorities([row(2, 'Call the bank', { done: true, uid: 'abcdef123456', addedAt: 5 })], 3);
    expect(rows.map((r) => r.text)).toEqual(['', 'Call the bank', '']);
    expect(rows[1]).toMatchObject({ done: true, uid: 'abcdef123456', addedAt: 5 });
  });

  it('shows every stored row even when the count was lowered', () => {
    const stored = [1, 2, 3, 4, 5].map((position) => row(position, `p${position}`));
    expect(padPriorities(stored, 2)).toHaveLength(5);
  });

  it('never marks an empty row done and never exceeds the cap', () => {
    expect(padPriorities([row(1, '  ', { done: true })], 1)[0]!.done).toBe(false);
    expect(padPriorities([], 99)).toHaveLength(MAX_PRIORITIES);
  });
});

describe('warnThreshold', () => {
  it('is three unless the default is higher', () => {
    expect(warnThreshold(1)).toBe(3);
    expect(warnThreshold(3)).toBe(3);
    expect(warnThreshold(5)).toBe(5);
  });
});

describe('warningKind', () => {
  it('depends on how much of the list is ticked', () => {
    expect(warningKind(0, 0)).toBe('fresh');
    expect(warningKind(0, 3)).toBe('fresh');
    expect(warningKind(1, 3)).toBe('progress');
    expect(warningKind(3, 3)).toBe('complete');
  });
});

describe('pickWarning', () => {
  it('draws from the pool for the kind', () => {
    expect(GENTLE_WARNINGS).toHaveLength(20);
    expect(PROGRESS_WARNINGS.length).toBeGreaterThanOrEqual(10);
    expect(COMPLETE_WARNINGS.length).toBeGreaterThanOrEqual(10);
    expect(GENTLE_WARNINGS).toContain(pickWarning('fresh'));
    expect(PROGRESS_WARNINGS).toContain(pickWarning('progress'));
    expect(COMPLETE_WARNINGS).toContain(pickWarning('complete'));
    expect(pickWarning('fresh', () => 0)).toBe(GENTLE_WARNINGS[0]);
    expect(pickWarning('fresh', () => 0.999999)).toBe(GENTLE_WARNINGS[19]);
    expect(pickWarning('complete', () => 0)).toBe(COMPLETE_WARNINGS[0]);
  });

  it('never repeats the previous phrase', () => {
    const first = PROGRESS_WARNINGS[0]!;
    for (let i = 0; i < 50; i++) expect(pickWarning('progress', Math.random, first)).not.toBe(first);
    expect(pickWarning('progress', () => 0, first)).toBe(PROGRESS_WARNINGS[1]);
  });
});

describe('newUid', () => {
  it('is twelve lowercase hex chars and not repeated', () => {
    const a = newUid();
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(newUid()).not.toBe(a);
  });
});

describe('placePriority', () => {
  it('fills the first empty row, padding first', () => {
    const next = placePriority([row(1, 'A')], 3, 'New task', 'abcdef123456', 100)!;
    expect(next.map((p) => p.text)).toEqual(['A', 'New task', '']);
    expect(next[1]).toMatchObject({ uid: 'abcdef123456', addedAt: 100, done: false });
  });

  it('appends when every row has text', () => {
    const rows = [row(1, 'A'), row(2, 'B'), row(3, 'C')];
    const next = placePriority(rows, 3, 'D', 'abcdef123456', 100)!;
    expect(next).toHaveLength(4);
    expect(next[3]).toMatchObject({ position: 4, text: 'D' });
  });

  it('refuses when the sheet is full', () => {
    const rows = Array.from({ length: MAX_PRIORITIES }, (_, i) => row(i + 1, `p${i + 1}`));
    expect(placePriority(rows, 3, 'One more', 'abcdef123456', 100)).toBeNull();
  });
});
