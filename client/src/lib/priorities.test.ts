import { describe, expect, it } from 'vitest';
import { PRIORITY_WARNINGS } from './copy';
import { editPriority, hasRoom, leftOpen, newUid, padPriorities, pickWarning, placePriority, removePriority, warnThreshold, warningKind } from './priorities';
import { MAX_PRIORITIES } from '../../../shared/settings.js';
import { makeDay, makePriority } from '../test/fixtures';
import type { Priority } from '../types';

describe('padPriorities', () => {
  it('fills a fresh day up to the configured count', () => {
    expect(padPriorities([], 3)).toEqual([1, 2, 3].map((position) => makePriority(position, '', { uid: null, addedAt: null })));
  });

  it('keeps stored rows in place and pads the rest', () => {
    const rows = padPriorities([makePriority(2, 'Call the bank', { done: true, uid: 'abcdef123456', addedAt: 5 })], 3);
    expect(rows.map((r) => r.text)).toEqual(['', 'Call the bank', '']);
    expect(rows[1]).toMatchObject({ done: true, uid: 'abcdef123456', addedAt: 5 });
  });

  it('shows every stored row even when the count was lowered', () => {
    const stored = [1, 2, 3, 4, 5].map((position) => makePriority(position, `p${position}`));
    expect(padPriorities(stored, 2)).toHaveLength(5);
  });

  it('never marks an empty row done and never exceeds the cap', () => {
    expect(padPriorities([makePriority(1, '  ', { done: true })], 1)[0]!.done).toBe(false);
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
    expect(PRIORITY_WARNINGS.fresh).toContain(pickWarning('fresh'));
    expect(PRIORITY_WARNINGS.progress).toContain(pickWarning('progress'));
    expect(PRIORITY_WARNINGS.complete).toContain(pickWarning('complete'));
    expect(pickWarning('fresh', () => 0)).toBe(PRIORITY_WARNINGS.fresh[0]);
    expect(pickWarning('fresh', () => 0.999999)).toBe(PRIORITY_WARNINGS.fresh.at(-1));
    expect(pickWarning('complete', () => 0)).toBe(PRIORITY_WARNINGS.complete[0]);
  });

  it('never repeats the previous phrase', () => {
    const first = PRIORITY_WARNINGS.progress[0]!;
    for (let i = 0; i < 50; i++) expect(pickWarning('progress', Math.random, first)).not.toBe(first);
    expect(pickWarning('progress', () => 0, first)).toBe(PRIORITY_WARNINGS.progress[1]);
  });
});

describe('newUid', () => {
  it('is twelve lowercase hex chars and not repeated', () => {
    const a = newUid();
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(newUid()).not.toBe(a);
  });
});

describe('editPriority', () => {
  const blank: Priority = { position: 2, text: '', done: false, uid: null, addedAt: null };

  it('mints a uid and stamps addedAt the first time a row gets text', () => {
    const next = editPriority(blank, { text: 'Ship it' }, 100);
    expect(next).toMatchObject({ position: 2, text: 'Ship it', done: false, addedAt: 100 });
    expect(next.uid).toMatch(/^[0-9a-f]{12}$/);
  });

  it('keeps the uid and addedAt through later edits and a clear', () => {
    const named = { ...blank, text: 'Ship it', uid: 'abcdef123456', addedAt: 100 };
    expect(editPriority(named, { text: 'Ship it today' }, 200)).toMatchObject({ uid: 'abcdef123456', addedAt: 100 });
    expect(editPriority(named, { text: '  ' }, 200)).toMatchObject({ text: '  ', uid: 'abcdef123456', addedAt: 100 });
  });

  it('ticks a row with text and clears the tick along with the text', () => {
    const named = { ...blank, text: 'Ship it', uid: 'abcdef123456', addedAt: 100 };
    expect(editPriority(named, { done: true }, 200).done).toBe(true);
    expect(editPriority({ ...named, done: true }, { text: '' }, 200).done).toBe(false);
    expect(editPriority(blank, { done: true }, 200)).toEqual(blank);
  });
});

describe('removePriority', () => {
  it('drops the row and renumbers the rest from 1', () => {
    const next = removePriority([makePriority(1, 'A'), makePriority(2, 'B'), makePriority(3, 'C')], 2);
    expect(next.map((p) => [p.position, p.text])).toEqual([
      [1, 'A'],
      [2, 'C'],
    ]);
  });
});

describe('placePriority', () => {
  it('fills the first empty row, padding first', () => {
    const next = placePriority([makePriority(1, 'A')], 3, 'New task', 'abcdef123456', 100)!;
    expect(next.map((p) => p.text)).toEqual(['A', 'New task', '']);
    expect(next[1]).toMatchObject({ uid: 'abcdef123456', addedAt: 100, done: false });
  });

  it('appends when every row has text', () => {
    const rows = [makePriority(1, 'A'), makePriority(2, 'B'), makePriority(3, 'C')];
    const next = placePriority(rows, 3, 'D', 'abcdef123456', 100)!;
    expect(next).toHaveLength(4);
    expect(next[3]).toMatchObject({ position: 4, text: 'D' });
  });

  it('refuses when the sheet is full', () => {
    const rows = Array.from({ length: MAX_PRIORITIES }, (_, i) => makePriority(i + 1, `p${i + 1}`));
    expect(placePriority(rows, 3, 'One more', 'abcdef123456', 100)).toBeNull();
  });
});

describe('hasRoom', () => {
  const full = Array.from({ length: MAX_PRIORITIES }, (_, i) => makePriority(i + 1, `p${i + 1}`));

  it('is false only when every row up to the cap has text', () => {
    const oneCleared = full.map((p) => (p.position === 7 ? { ...p, text: '  ' } : p));
    expect(hasRoom([], 3)).toBe(true);
    expect(hasRoom(full, 3)).toBe(false);
    expect(hasRoom(full.slice(0, -1), 3)).toBe(true);
    expect(hasRoom(oneCleared, 3)).toBe(true);
  });
});

describe('leftOpen', () => {
  it('takes the latest day that had a plan and returns its unticked rows in order', () => {
    const days = [
      makeDay('2026-09-24', { priorities: [makePriority(1, 'Old thing')] }),
      makeDay('2026-09-25', {
        priorities: [makePriority(1, 'Ship it', { done: true }), makePriority(2, 'Review the PR'), makePriority(3, 'Call the bank'), makePriority(4, '  ')],
      }),
      // A later day with nothing written doesn't count as a plan.
      makeDay('2026-09-26', { priorities: [makePriority(1, '')] }),
    ];
    expect(leftOpen(days)).toEqual({ date: '2026-09-25', rows: [makePriority(2, 'Review the PR'), makePriority(3, 'Call the bank')] });
  });

  it('finds the latest day whatever order the days come in', () => {
    expect(
      leftOpen([makeDay('2026-09-25', { priorities: [makePriority(1, 'Newer')] }), makeDay('2026-09-24', { priorities: [makePriority(1, 'Older')] })])?.date,
    ).toBe('2026-09-25');
  });

  it('is null when no day had a plan or the last plan was finished', () => {
    expect(leftOpen([])).toBeNull();
    expect(leftOpen([makeDay('2026-09-25', { priorities: [] })])).toBeNull();
    expect(
      leftOpen([
        makeDay('2026-09-24', { priorities: [makePriority(1, 'Open')] }),
        makeDay('2026-09-25', { priorities: [makePriority(1, 'Done', { done: true })] }),
      ]),
    ).toBeNull();
  });
});
