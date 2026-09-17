import { describe, expect, it } from 'vitest';
import { GENTLE_WARNINGS } from './copy';
import { MAX_PRIORITIES, padPriorities, pickWarning, warnThreshold } from './priorities';

describe('padPriorities', () => {
  it('fills a fresh day up to the configured count', () => {
    expect(padPriorities([], 3)).toEqual([
      { position: 1, text: '', done: false },
      { position: 2, text: '', done: false },
      { position: 3, text: '', done: false },
    ]);
  });

  it('keeps stored rows in place and pads the rest', () => {
    const rows = padPriorities([{ position: 2, text: 'Call the bank', done: true }], 3);
    expect(rows.map((r) => r.text)).toEqual(['', 'Call the bank', '']);
    expect(rows[1]!.done).toBe(true);
  });

  it('shows every stored row even when the count was lowered', () => {
    const stored = [1, 2, 3, 4, 5].map((position) => ({ position, text: `p${position}`, done: false }));
    expect(padPriorities(stored, 2)).toHaveLength(5);
  });

  it('never marks an empty row done and never exceeds the cap', () => {
    expect(padPriorities([{ position: 1, text: '  ', done: true }], 1)[0]!.done).toBe(false);
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

describe('pickWarning', () => {
  it('has twenty phrases and returns one of them', () => {
    expect(GENTLE_WARNINGS).toHaveLength(20);
    expect(GENTLE_WARNINGS).toContain(pickWarning());
    expect(pickWarning(() => 0)).toBe(GENTLE_WARNINGS[0]);
    expect(pickWarning(() => 0.999999)).toBe(GENTLE_WARNINGS[19]);
  });

  it('never repeats the previous phrase', () => {
    const first = GENTLE_WARNINGS[0]!;
    for (let i = 0; i < 50; i++) expect(pickWarning(Math.random, first)).not.toBe(first);
    expect(pickWarning(() => 0, first)).toBe(GENTLE_WARNINGS[1]);
  });
});
