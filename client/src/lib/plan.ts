import type { Priority } from '../types';
import { addDays, isWeekend } from '../../../shared/dates.js';
import { hasText, isFree, sharesLink } from '../../../shared/priorities.js';
import { MAX_PRIORITIES } from '../../../shared/settings.js';
import { sameText } from '../../../shared/text.js';
import { newUid, takeBack } from './priorities';

/**
 * The day a plan made on `date` is for: the next one, or with weekends off the calendar (not
 * work days, then) the next weekday, so Friday's plan lands on Monday.
 */
export function nextWorkDay(date: string, showWeekends: boolean): string {
  let next = addDays(date, 1);
  if (!showWeekends) while (isWeekend(next)) next = addDays(next, 1);
  return next;
}

/** What a row put on a day's list from elsewhere starts from: its text and its links. A row carried over is its own seed. */
export type PrioritySeed = Pick<Priority, 'text' | 'cardUid' | 'recurringUid' | 'categoryUid'>;

/** A seed for a priority typed new, linked to no card or recurring priority, in `categoryUid` if given. */
export function textSeed(text: string, categoryUid: string | null = null): PrioritySeed {
  return { text, cardUid: null, recurringUid: null, categoryUid };
}

/**
 * That day's list with `seeds` added after what it already holds. A seed is skipped when a row
 * with text there, or an earlier seed, has its text (`sameText`) or holds its non-null
 * `cardUid` or `recurringUid`; a null link matches nothing. A cleared row that holds its link
 * takes it back (`takeBack`), keeping its uid and `addedAt` so the time logged on it counts
 * again. Only rows never written in are dropped: any other cleared row keeps its uid and the
 * sessions on it. Each new row gets its own uid and `addedAt` now, so it counts as planned on
 * its day unless a completed session there started before it (`reviewDay`), and carries the
 * seed's links and category: the same task on a row of its own. Nothing goes past the list's
 * limit. `added` counts the rows filled.
 */
export function planNext(existing: Priority[], seeds: PrioritySeed[], now = Date.now()): { rows: Priority[]; added: number } {
  const rows = existing.filter((p) => !isFree(p));
  let added = 0;
  for (const seed of seeds) {
    const text = seed.text.trim();
    if (!text || rows.some((p) => hasText(p) && (sameText(p.text) === sameText(text) || sharesLink(p, seed)))) continue;
    const row: Priority = {
      position: 0,
      text,
      done: false,
      uid: newUid(),
      addedAt: now,
      cardUid: seed.cardUid,
      recurringUid: seed.recurringUid,
      categoryUid: seed.categoryUid,
    };
    const cleared = rows.findIndex((p) => sharesLink(p, seed));
    if (cleared !== -1) rows[cleared] = takeBack(rows[cleared]!, row);
    else if (rows.length < MAX_PRIORITIES) rows.push(row);
    else continue;
    added++;
  }
  return { rows: rows.map((p, i) => ({ ...p, position: i + 1 })), added };
}
