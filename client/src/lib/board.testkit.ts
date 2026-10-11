import { QUEUE } from '../test/fixtures';
import { boardColumns, type BoardColumns, type BoardItem, type ColumnsInput } from './board';

// What the board.*.test.ts files share.

// A Wednesday, so the week has a Monday and a Tuesday before it.
export const MON = '2026-09-28';
export const TUE = '2026-09-29';
export const WED = '2026-09-30';
export const THU = '2026-10-01';
export const FRI = '2026-10-02';

export function columns(input: Partial<ColumnsInput> = {}): BoardColumns {
  return boardColumns({ cards: [], today: WED, todayRows: [], earlierDays: [], recurring: [], ...input });
}

/** Each column as its items' ids. */
export function ids(c: BoardColumns): Record<keyof BoardColumns, string[]> {
  const of = (items: BoardItem[]) => items.map((i) => i.id);
  return {
    later: of(c.later),
    repeats: of(c.repeats),
    next: of(c.next),
    progress: of(c.progress),
    doneToday: of(c.doneToday),
    doneEarlier: of(c.doneEarlier),
  };
}

export const ROUTINE = { uid: QUEUE.uid, recurring: true };
