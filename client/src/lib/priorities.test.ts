import { describe, expect, it } from 'vitest';
import { PRIORITY_WARNINGS } from './copy';
import {
  editPriority,
  emptyRow,
  hasRoom,
  leftOpen,
  newUid,
  nudgeFor,
  padPriorities,
  pickWarning,
  placePriority,
  removePriority,
  warnThreshold,
  warningKind,
} from './priorities';
import { MAX_PRIORITIES } from '../../../shared/settings.js';
import { makeDay, makePriority } from '../test/fixtures';
import type { Priority } from '../types';

const CARD = { cardUid: 'card00000001' };
const ROUTINE = { recurringUid: 'rcur00000001' };

describe('emptyRow', () => {
  it('is a row never written in, linked to nothing', () => {
    expect(emptyRow(4)).toEqual(makePriority(4, '', { uid: null, addedAt: null }));
  });
});

describe('padPriorities', () => {
  it('fills a fresh day up to the configured count', () => {
    expect(padPriorities([], 3)).toEqual([1, 2, 3].map(emptyRow));
  });

  it('keeps stored rows in place, every field of them, and pads the rest', () => {
    const stored = makePriority(2, 'Call the bank', { done: true, uid: 'abcdef123456', addedAt: 5, ...CARD, categoryUid: 'cafe00000001' });
    const rows = padPriorities([stored], 3);
    expect(rows.map((r) => r.text)).toEqual(['', 'Call the bank', '']);
    expect(rows[1]).toEqual(stored);
  });

  it('shows every stored row even when the count was lowered', () => {
    const stored = [1, 2, 3, 4, 5].map((position) => makePriority(position, `p${position}`));
    expect(padPriorities(stored, 2)).toHaveLength(5);
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

describe('nudgeFor', () => {
  it('stays quiet until the rows with text reach the threshold', () => {
    expect(nudgeFor([makePriority(1, 'A'), makePriority(2, 'B')], 3)).toBeNull();
    expect(nudgeFor([makePriority(1, 'A'), makePriority(2, 'B'), makePriority(3, 'C')], 3)).toBe('fresh');
    // A higher Rows per day raises the threshold.
    expect(nudgeFor([makePriority(1, 'A'), makePriority(2, 'B'), makePriority(3, 'C')], 4)).toBeNull();
  });

  it('counts only rows with text: an emptied row and a row never written in add nothing', () => {
    const rows = [makePriority(1, 'A'), makePriority(2, ''), makePriority(3, 'C'), makePriority(4, ' ', { uid: null, addedAt: null })];
    expect(nudgeFor(rows, 3)).toBeNull();
  });

  it('picks the kind from how many rows with text are ticked', () => {
    const rows = [makePriority(1, 'A', { done: true }), makePriority(2, 'B'), makePriority(3, 'C')];
    expect(nudgeFor(rows, 3)).toBe('progress');
    expect(nudgeFor([...rows.map((p) => ({ ...p, done: true })), makePriority(4, '')], 3)).toBe('complete');
  });
});

describe('pickWarning', () => {
  it('draws from the pool for the kind', () => {
    expect(PRIORITY_WARNINGS.fresh).toContain(pickWarning('fresh'));
    expect(PRIORITY_WARNINGS.progress).toContain(pickWarning('progress'));
    expect(PRIORITY_WARNINGS.complete).toContain(pickWarning('complete'));
    expect(pickWarning('fresh', undefined, () => 0)).toBe(PRIORITY_WARNINGS.fresh[0]);
    expect(pickWarning('fresh', undefined, () => 0.999999)).toBe(PRIORITY_WARNINGS.fresh.at(-1));
    expect(pickWarning('complete', undefined, () => 0)).toBe(PRIORITY_WARNINGS.complete[0]);
  });

  it('never repeats the previous phrase', () => {
    const first = PRIORITY_WARNINGS.progress[0]!;
    expect(pickWarning('progress', first, () => 0)).toBe(PRIORITY_WARNINGS.progress[1]);
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
  const blank: Priority = emptyRow(2);

  it('mints a uid and stamps addedAt the first time a row gets text', () => {
    const next = editPriority(blank, { text: 'Ship it' }, 100);
    expect(next).toMatchObject({ position: 2, text: 'Ship it', done: false, addedAt: 100 });
    expect(next.uid).toMatch(/^[0-9a-f]{12}$/);
  });

  it('keeps the uid, addedAt and links through later edits and a clear: a cleared row is the same item', () => {
    const named = { ...blank, text: 'Ship it', uid: 'abcdef123456', addedAt: 100, ...CARD, categoryUid: 'cafe00000001' };
    const kept = { uid: 'abcdef123456', addedAt: 100, ...CARD, categoryUid: 'cafe00000001' };
    expect(editPriority(named, { text: 'Ship it today' }, 200)).toMatchObject(kept);
    expect(editPriority(named, { text: '  ' }, 200)).toMatchObject({ text: '  ', ...kept });
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
  /** The row placed, as the timer's Also add builds it: a fresh uid, stamped now, linked to nothing unless patched. */
  const placed = (text: string, patch: Partial<Priority> = {}) => makePriority(0, text, { uid: 'abcdef123456', addedAt: 100, ...patch });

  it('fills the first row never written in, padding first', () => {
    const next = placePriority([makePriority(1, 'A')], 3, placed('New task', { categoryUid: 'cafe00000001' }))!;
    expect(next.map((p) => p.text)).toEqual(['A', 'New task', '']);
    expect(next[1]).toEqual(placed('New task', { position: 2, categoryUid: 'cafe00000001' }));
  });

  it('stamps the row placed in a free row with its own addedAt, never one the free row was stored with', () => {
    // A free row a save sent with an addedAt (curl) is stored with it.
    const next = placePriority([makePriority(1, 'A'), { ...emptyRow(2), addedAt: 7 }], 3, placed('New task'))!;
    expect(next[1]).toEqual(placed('New task', { position: 2 }));
  });

  it('appends when every row has text, none of them linked: a null link matches nothing', () => {
    const rows = [makePriority(1, 'A'), makePriority(2, 'B'), makePriority(3, 'C')];
    const next = placePriority(rows, 3, placed('D'))!;
    expect(next).toHaveLength(4);
    expect(next[3]).toMatchObject({ position: 4, text: 'D' });
  });

  it('passes a cleared row, which keeps its uid and the sessions on it, for one never written in', () => {
    const cleared = makePriority(2, '', { uid: 'cleared00000' });
    const next = placePriority([makePriority(1, 'A'), cleared], 3, placed('New task'))!;
    expect(next.map((p) => [p.text, p.uid])).toEqual([
      ['A', makePriority(1, 'A').uid],
      ['', 'cleared00000'],
      ['New task', 'abcdef123456'],
    ]);
  });

  it('appends rather than take a cleared row when the list has no free row', () => {
    const rows = [makePriority(1, 'A'), makePriority(2, '  ', { uid: 'cleared00000' }), makePriority(3, 'C')];
    const next = placePriority(rows, 3, placed('D'))!;
    expect(next.map((p) => [p.position, p.text, p.uid])).toEqual([
      [1, 'A', rows[0]!.uid],
      [2, '  ', 'cleared00000'],
      [3, 'C', rows[2]!.uid],
      [4, 'D', 'abcdef123456'],
    ]);
  });

  it('takes back the cleared row that holds the card or the recurring priority placed, keeping its uid and addedAt', () => {
    const cleared = makePriority(2, '', { uid: 'cleared00000', addedAt: 50, ...CARD });
    const next = placePriority([makePriority(1, 'A'), cleared], 3, placed('Invoices', { ...CARD, categoryUid: 'cafe00000001' }))!;
    expect(next).toEqual([
      makePriority(1, 'A'),
      { ...placed('Invoices', { ...CARD, categoryUid: 'cafe00000001' }), position: 2, uid: 'cleared00000', addedAt: 50 },
      emptyRow(3),
    ]);
    const routine = makePriority(1, '', { uid: 'cleared00000', addedAt: 50, ...ROUTINE });
    expect(placePriority([routine], 1, placed('Queue', ROUTINE))).toEqual([{ ...placed('Queue', ROUTINE), position: 1, uid: 'cleared00000', addedAt: 50 }]);
  });

  it('keeps the category of the cleared row it takes back when the row placed brings none', () => {
    const cleared = makePriority(1, '', { uid: 'cleared00000', addedAt: 50, ...CARD, categoryUid: 'cafe00000002' });
    expect(placePriority([cleared], 1, placed('Invoices', CARD))![0]).toMatchObject({ text: 'Invoices', uid: 'cleared00000', categoryUid: 'cafe00000002' });
  });

  it('changes nothing when a row with text already holds the card or the recurring priority', () => {
    const rows = [makePriority(1, 'Invoices', CARD), makePriority(2, 'Queue', ROUTINE)];
    expect(placePriority(rows, 3, placed('Invoices again', CARD))).toEqual([...rows, emptyRow(3)]);
    expect(placePriority(rows, 2, placed('Queue', ROUTINE))).toEqual(rows);
  });

  it('refuses when the sheet is full', () => {
    const rows = Array.from({ length: MAX_PRIORITIES }, (_, i) => makePriority(i + 1, `p${i + 1}`));
    expect(placePriority(rows, 3, placed('One more'))).toBeNull();
    // A cleared row still stands for its item, so a full list with one is full.
    const oneCleared = rows.map((p) => (p.position === 7 ? { ...p, text: '' } : p));
    expect(placePriority(oneCleared, 3, placed('One more'))).toBeNull();
  });
});

describe('hasRoom', () => {
  const full = Array.from({ length: MAX_PRIORITIES }, (_, i) => makePriority(i + 1, `p${i + 1}`));

  it('is false only when the list is at the cap with no row never written in', () => {
    const oneFree = full.map((p) => (p.position === 7 ? { ...p, text: '  ', uid: null, addedAt: null } : p));
    const oneCleared = full.map((p) => (p.position === 7 ? { ...p, text: '  ' } : p));
    expect(hasRoom([], 3)).toBe(true);
    expect(hasRoom(full, 3)).toBe(false);
    expect(hasRoom(full.slice(0, -1), 3)).toBe(true);
    expect(hasRoom(oneFree, 3)).toBe(true);
    // A cleared row keeps its uid and is not somewhere to put a new priority.
    expect(hasRoom(oneCleared, 3)).toBe(false);
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
