import { describe, expect, it } from 'vitest';
import { PRIORITY_WARNINGS } from './copy';
import {
  clearRow,
  editPriority,
  emptyRow,
  hasRoom,
  carriesOver,
  isOneOff,
  leftOpen,
  newTaskRow,
  newUid,
  nudgeFor,
  padPriorities,
  pickWarning,
  placePriority,
  removePriority,
  takeOffRow,
} from './priorities';
import { MAX_PRIORITIES } from '../../../shared/settings.js';
import { makeDay, makePriority } from '../test/fixtures';
import type { Priority } from '../types';

const ROUTINE = { uid: 'rcur00000001', recurring: true };

describe('emptyRow', () => {
  it('is a free row: no task on it, on no day and with nothing logged', () => {
    expect(emptyRow(4)).toEqual(makePriority(4, '', { uid: null, addedAt: null, listed: 0 }));
  });
});

describe('newTaskRow', () => {
  it('is a task typed new: a uid of its own, added now, in the category given, on no other day', () => {
    const row = newTaskRow('Ship it', 'cafe00000001', 100);
    const { position: _position, ...expected } = makePriority(0, 'Ship it', { uid: row.uid, addedAt: 100, categoryUid: 'cafe00000001', listed: 0 });
    expect(row).toStrictEqual(expected);
    expect(row.uid).toMatch(/^[0-9a-f]{12}$/);
    expect(newTaskRow('Ship it', null, 100).uid).not.toBe(row.uid);
  });
});

describe('isOneOff', () => {
  it("is a row with text that isn't a recurring priority's", () => {
    expect(isOneOff(makePriority(1, 'Report'))).toBe(true);
    expect(isOneOff(makePriority(1, ' '))).toBe(false);
    expect(isOneOff(makePriority(1, 'Monitor the queue', ROUTINE))).toBe(false);
  });
});

describe('carriesOver', () => {
  it('is an open one-off row: never ticked, empty, a routine or archived', () => {
    expect(carriesOver(makePriority(1, 'Report'))).toBe(true);
    expect(carriesOver(makePriority(1, 'Report', { done: true }))).toBe(false);
    expect(carriesOver(makePriority(1, ''))).toBe(false);
    expect(carriesOver(makePriority(1, 'Monitor the queue', ROUTINE))).toBe(false);
    expect(carriesOver(makePriority(1, 'Old card', { archived: true }))).toBe(false);
  });
});

describe('padPriorities', () => {
  it('fills a fresh day up to the configured count', () => {
    expect(padPriorities([], 3)).toEqual([1, 2, 3].map(emptyRow));
  });

  it('keeps stored rows in place, every field of them, and pads the gaps and the rest', () => {
    const stored = makePriority(2, 'Call the bank', {
      done: true,
      uid: 'abcdef123456',
      addedAt: 5,
      categoryUid: 'cafe00000001',
      listed: 3,
      earlier: 1,
      logged: 60,
    });
    const routine = makePriority(5, 'Monitor the queue', ROUTINE);
    const rows = padPriorities([stored, routine], 3);
    expect(rows.map((r) => r.text)).toEqual(['', 'Call the bank', '', '', 'Monitor the queue']);
    expect(rows[1]).toEqual(stored);
    expect(rows[3]).toEqual(emptyRow(4));
  });

  it('shows every stored row even when the count was lowered', () => {
    const stored = [1, 2, 3, 4, 5].map((position) => makePriority(position, `p${position}`));
    expect(padPriorities(stored, 2)).toHaveLength(5);
  });
});

describe('nudgeFor', () => {
  it('stays quiet until the rows with text reach the threshold', () => {
    expect(nudgeFor([makePriority(1, 'A'), makePriority(2, 'B')], 3)).toBeNull();
    expect(nudgeFor([makePriority(1, 'A'), makePriority(2, 'B'), makePriority(3, 'C')], 3)).toBe('fresh');
    // A higher Rows per day raises the threshold; a lower one never takes it under three.
    expect(nudgeFor([makePriority(1, 'A'), makePriority(2, 'B'), makePriority(3, 'C')], 4)).toBeNull();
    expect(nudgeFor([makePriority(1, 'A'), makePriority(2, 'B')], 1)).toBeNull();
  });

  it('counts only rows with text: a blank draft and a free row add nothing', () => {
    const rows = [makePriority(1, 'A'), makePriority(2, ''), makePriority(3, 'C'), makePriority(4, ' ', { uid: null, addedAt: null })];
    expect(nudgeFor(rows, 3)).toBeNull();
  });

  it('picks the kind from how many rows with text are ticked', () => {
    const rows = [makePriority(1, 'A', { done: true }), makePriority(2, 'B'), makePriority(3, 'C')];
    expect(nudgeFor(rows, 3)).toBe('progress');
    expect(nudgeFor([...rows.map((p) => ({ ...p, done: true })), makePriority(4, '')], 3)).toBe('complete');
  });

  it('leaves the routines out of the threshold, and counts them in the kind', () => {
    const routines = [1, 2, 3].map((n) => makePriority(n, `Routine ${n}`, { uid: `rcur0000000${n}`, recurring: true, done: true }));
    const oneOffs = (n: number) => Array.from({ length: n }, (_, i) => makePriority(4 + i, `One-off ${i + 1}`));
    expect(nudgeFor([...routines, ...oneOffs(2)], 3)).toBeNull();
    // Three open one-offs reach it; the three ticked routines make it a list with progress.
    expect(nudgeFor([...routines, ...oneOffs(3)], 3)).toBe('progress');
    expect(nudgeFor(oneOffs(3), 3)).toBe('fresh');
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
  const named = { ...blank, text: 'Ship it', uid: 'abcdef123456', addedAt: 100, categoryUid: 'cafe00000001' };

  it('mints a uid and stamps addedAt the first time a free row gets text', () => {
    const next = editPriority(blank, { text: 'Ship it' }, 100);
    expect(next).toMatchObject({ position: 2, text: 'Ship it', done: false, addedAt: 100 });
    expect(next.uid).toMatch(/^[0-9a-f]{12}$/);
  });

  it("keeps the task's uid, addedAt and category through later edits and a blank box", () => {
    const kept = { uid: 'abcdef123456', addedAt: 100, categoryUid: 'cafe00000001' };
    expect(editPriority(named, { text: 'Ship it today' }, 200)).toMatchObject(kept);
    expect(editPriority(named, { text: '  ' }, 200)).toMatchObject({ text: '  ', ...kept });
  });

  it("ticks a task's row and keeps the tick while its box is blank, since the name comes back; a free row can't be done", () => {
    expect(editPriority(named, { done: true }, 200).done).toBe(true);
    expect(editPriority({ ...named, done: true }, { text: '' }, 200).done).toBe(true);
    expect(editPriority(blank, { done: true }, 200)).toEqual(blank);
  });
});

describe('clearRow', () => {
  it('leaves a free row where the task was, and the other rows where they are', () => {
    const rows = [makePriority(1, 'A'), makePriority(2, 'B', { done: true }), makePriority(3, 'C')];
    expect(clearRow(rows, 2)).toEqual([rows[0], emptyRow(2), rows[2]]);
  });
});

describe('takeOffRow', () => {
  it('leaves a free row within Rows per day, and drops the row past it', () => {
    const rows = [makePriority(1, 'A'), makePriority(2, 'B'), makePriority(3, 'C')];
    expect(takeOffRow(rows, 1, 2)).toEqual(clearRow(rows, 1));
    expect(takeOffRow(rows, 2, 2)).toEqual(clearRow(rows, 2));
    expect(takeOffRow(rows, 3, 2)).toEqual(removePriority(rows, 3));
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
  /** The row placed, as the timer's Also add builds it: a fresh uid, stamped now, unless patched. */
  const placed = (text: string, patch: Partial<Priority> = {}) => makePriority(0, text, { uid: 'abcdef123456', addedAt: 100, ...patch });

  it('fills the first free row, padding first', () => {
    const next = placePriority([makePriority(1, 'A')], 3, placed('New task', { categoryUid: 'cafe00000001' }))!;
    expect(next.map((p) => p.text)).toEqual(['A', 'New task', '']);
    expect(next[1]).toEqual(placed('New task', { position: 2, categoryUid: 'cafe00000001' }));
  });

  it('fills a gap the stored positions left', () => {
    const next = placePriority([makePriority(1, 'A'), makePriority(3, 'C')], 3, placed('B'))!;
    expect(next.map((p) => [p.position, p.text])).toEqual([
      [1, 'A'],
      [2, 'B'],
      [3, 'C'],
    ]);
  });

  it('appends when every row has a task', () => {
    const rows = [makePriority(1, 'A'), makePriority(2, 'B'), makePriority(3, 'C')];
    const next = placePriority(rows, 3, placed('D'))!;
    expect(next).toHaveLength(4);
    expect(next[3]).toMatchObject({ position: 4, text: 'D' });
  });

  it('changes nothing when a row of the list is that task already, its box blank in the draft or not, whatever the row placed is called', () => {
    const rows = [makePriority(1, 'Invoices', { uid: 'abcdef123456' }), makePriority(2, '', ROUTINE)];
    expect(placePriority(rows, 3, placed('Invoices again'))).toEqual([...rows, emptyRow(3)]);
    expect(placePriority(rows, 2, placed('Queue', ROUTINE))).toEqual(rows);
  });

  it('matches a task by its uid only: another task of the same name is placed', () => {
    const next = placePriority([makePriority(1, 'Invoices')], 2, placed('Invoices'))!;
    expect(next.map((p) => [p.text, p.uid])).toEqual([
      ['Invoices', makePriority(1, 'Invoices').uid],
      ['Invoices', 'abcdef123456'],
    ]);
  });

  it('with end, goes after every row of the padded list, past the free rows', () => {
    const next = placePriority([makePriority(1, 'A')], 3, placed('Queue', ROUTINE), { end: true })!;
    expect(next).toEqual([makePriority(1, 'A'), emptyRow(2), emptyRow(3), { ...placed('Queue', ROUTINE), position: 4 }]);
  });

  it('with end, still changes nothing for a repeat', () => {
    const rows = [makePriority(1, 'Queue', ROUTINE)];
    expect(placePriority(rows, 2, placed('Queue', ROUTINE), { end: true })).toEqual([...rows, emptyRow(2)]);
  });

  it('with end, takes a free row at the cap, and refuses a full list', () => {
    const full = Array.from({ length: MAX_PRIORITIES }, (_, i) => makePriority(i + 1, `p${i + 1}`));
    const oneFree = full.map((p) => (p.position === 7 ? emptyRow(7) : p));
    expect(placePriority(oneFree, 3, placed('Queue', ROUTINE), { end: true })![6]).toEqual({ ...placed('Queue', ROUTINE), position: 7 });
    expect(placePriority(full, 3, placed('Queue', ROUTINE), { end: true })).toBeNull();
  });

  it('refuses when the sheet is full, a blank draft of a task included', () => {
    const rows = Array.from({ length: MAX_PRIORITIES }, (_, i) => makePriority(i + 1, `p${i + 1}`));
    expect(placePriority(rows, 3, placed('One more'))).toBeNull();
    const oneBlank = rows.map((p) => (p.position === 7 ? { ...p, text: '' } : p));
    expect(placePriority(oneBlank, 3, placed('One more'))).toBeNull();
  });
});

describe('hasRoom', () => {
  const full = Array.from({ length: MAX_PRIORITIES }, (_, i) => makePriority(i + 1, `p${i + 1}`));

  it('is false only when the list is at the cap with no free row', () => {
    const oneFree = full.map((p) => (p.position === 7 ? emptyRow(7) : p));
    expect(hasRoom([], 3)).toBe(true);
    expect(hasRoom(full, 3)).toBe(false);
    expect(hasRoom(full.slice(0, -1), 3)).toBe(true);
    expect(hasRoom(oneFree, 3)).toBe(true);
    // A task's row with its box blank is still that task's.
    expect(
      hasRoom(
        full.map((p) => (p.position === 7 ? { ...p, text: '  ' } : p)),
        3,
      ),
    ).toBe(false);
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

  it('carries no routine, and passes a day that held only routines', () => {
    const queue = makePriority(1, 'Monitor the queue', ROUTINE);
    const days = [
      makeDay('2026-09-24', { priorities: [makePriority(1, 'Review the PR'), makePriority(2, 'Follow-ups', { uid: 'rcur00000002', recurring: true })] }),
      makeDay('2026-09-25', { priorities: [queue] }),
    ];
    expect(leftOpen(days)).toEqual({ date: '2026-09-24', rows: [makePriority(1, 'Review the PR')] });
    // A plan whose one-offs are all ticked carries nothing, its open routine included.
    expect(leftOpen([makeDay('2026-09-25', { priorities: [makePriority(1, 'Ship it', { done: true }), { ...queue, position: 2 }] })])).toBeNull();
  });

  it('never offers an archived task, and still offers the open rows beside it', () => {
    const deleted = makePriority(1, 'Deleted on the board', { archived: true });
    const days = [makeDay('2026-09-25', { priorities: [deleted, makePriority(2, 'Review the PR')] })];
    expect(leftOpen(days)).toEqual({ date: '2026-09-25', rows: [makePriority(2, 'Review the PR')] });
    expect(leftOpen([makeDay('2026-09-25', { priorities: [deleted] })])).toBeNull();
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
