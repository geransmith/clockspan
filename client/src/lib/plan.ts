import type { Priority } from '../types';
import { addDays, parseDateKey, sameText } from './format';
import { MAX_PRIORITIES, newUid } from './priorities';

/**
 * The day a plan made on `date` is for: the next one, or with weekends off the calendar (not
 * work days, then) the next weekday, so Friday's plan lands on Monday.
 */
export function nextWorkDay(date: string, showWeekends: boolean): string {
  let next = addDays(date, 1);
  if (!showWeekends) while ([0, 6].includes(parseDateKey(next).getDay())) next = addDays(next, 1);
  return next;
}

/**
 * That day's list with `texts` added after what it already holds. Rows already there by text
 * aren't added twice, and nothing goes past the list's limit. Each new row gets its own uid and
 * `addedAt` now, the evening before, so the next day's retrospective counts it as planned.
 */
export function planNext(existing: Priority[], texts: string[], now = Date.now()): { rows: Priority[]; added: number } {
  const kept = existing.filter((p) => p.text.trim()).sort((a, b) => a.position - b.position);
  const seen = new Set(kept.map((p) => sameText(p.text)));
  const rows = [...kept];
  for (const text of texts) {
    const key = sameText(text);
    if (!key || seen.has(key) || rows.length >= MAX_PRIORITIES) continue;
    seen.add(key);
    rows.push({ position: 0, text: text.trim(), done: false, uid: newUid(), addedAt: now });
  }
  return { rows: rows.map((p, i) => ({ ...p, position: i + 1 })), added: rows.length - kept.length };
}
