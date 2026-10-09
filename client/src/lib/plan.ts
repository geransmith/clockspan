import type { Priority } from '../types';
import { addDays, isWeekend } from '../../../shared/dates.js';
import { hasText, isFree } from '../../../shared/priorities.js';
import { MAX_PRIORITIES } from '../../../shared/settings.js';
import { sameText } from '../../../shared/text.js';
import { newTaskRow } from './priorities';

/**
 * The day a plan made on `date` is for: the next one, or with weekends off the calendar (not
 * work days, then) the next weekday, so Friday's plan lands on Monday.
 */
export function nextWorkDay(date: string, showWeekends: boolean): string {
  let next = addDays(date, 1);
  if (!showWeekends) while (isWeekend(next)) next = addDays(next, 1);
  return next;
}

/**
 * What a row put on a day's list from elsewhere starts from: its task (`uid`, null for a priority
 * typed new), its name and category, and the counts the server gave its source row, which the new
 * row shows until its save answers. A row carried over is its own seed.
 */
export type PrioritySeed = Pick<Priority, 'uid' | 'text' | 'categoryUid'> & Partial<Pick<Priority, 'listed' | 'earlier' | 'logged'>>;

/** A seed for a priority typed new, in `categoryUid` if given: the save that names it makes its task. */
export function textSeed(text: string, categoryUid: string | null = null): PrioritySeed {
  return { uid: null, text, categoryUid };
}

/**
 * Whether `seed` stands for the task `row` holds: the same uid, whatever either is called; a
 * seed typed new matches a row with its text (`sameText`), a guard against typing one thing twice
 * on one list.
 */
export function sameItem(row: Pick<Priority, 'uid' | 'text'>, seed: PrioritySeed): boolean {
  return seed.uid != null ? row.uid === seed.uid : hasText(row) && sameText(row.text) === sameText(seed.text);
}

/**
 * The row `seed` puts on a list, added `now`: its own task, or a uid of its own for one typed new,
 * with its source row's counts until the save answers.
 */
export function seedRow(seed: PrioritySeed, now: number): Omit<Priority, 'position'> {
  const row = newTaskRow(seed.text, seed.categoryUid, now);
  return { ...row, uid: seed.uid ?? row.uid, listed: seed.listed ?? 0, earlier: seed.earlier ?? 0, logged: seed.logged ?? 0 };
}

/**
 * That day's list with `seeds` added after what it already holds. A seed is skipped when a row
 * there, or an earlier seed's, stands for the same task (`sameItem`). Only free rows are dropped.
 * A carried seed puts its own task on the list, so the time logged on it counts on the new day
 * too; one typed new gets a uid of its own. Each new row is added `now`, so it counts as planned
 * on its day unless a completed session there started before it (`reviewDay`). Nothing goes past
 * the list's limit. `added` counts the rows filled.
 */
export function planNext(existing: Priority[], seeds: PrioritySeed[], now = Date.now()): { rows: Priority[]; added: number } {
  const rows = existing.filter((p) => !isFree(p));
  let added = 0;
  for (const seed of seeds) {
    const text = seed.text.trim();
    if (!text || rows.length >= MAX_PRIORITIES || rows.some((p) => sameItem(p, seed))) continue;
    rows.push({ ...seedRow({ ...seed, text }, now), position: 0 });
    added++;
  }
  return { rows: rows.map((p, i) => ({ ...p, position: i + 1 })), added };
}
