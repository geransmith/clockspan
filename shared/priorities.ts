import type { Priority } from './api.js';
import { MAX_PRIORITIES } from './settings.js';
import { sameText } from './text.js';

/** A row with something written in it; the others are the card's empty slots. */
export function hasText(p: { text: string }): boolean {
  return p.text.trim() !== '';
}

/**
 * A row nothing was ever written in: empty, with no uid. A row emptied later keeps its uid and
 * still stands for its item (its sessions point at it), so a new priority goes only into a free
 * row, or a new one.
 */
export function isFree(p: Priority): boolean {
  return p.uid == null && !hasText(p);
}

type MergedField = Exclude<keyof Priority, 'position' | 'uid'>;

/**
 * How a save treats each field of a row the server holds. `'merge'`: this device's value where
 * it differs from the base its list was built on, else the stored one. `'fixed'`: the stored
 * value whatever arrives, and this device's only for a row the server doesn't hold, so a draft
 * or a tab from before the server linked a row can't unlink it. A new `Priority` field fails
 * typecheck until it is listed here.
 */
export const MERGED: Record<MergedField, 'merge' | 'fixed'> = {
  text: 'merge',
  done: 'merge',
  addedAt: 'merge',
  cardUid: 'fixed',
  recurringUid: 'fixed',
  categoryUid: 'merge',
};
const FIELDS = Object.keys(MERGED) as MergedField[];
const MERGE_FIELDS = FIELDS.filter((f) => MERGED[f] === 'merge');
const FIXED_FIELDS = FIELDS.filter((f) => MERGED[f] === 'fixed');

/** The links a list holds one text row for: the row's card and its recurring priority. A category is shared by many rows. */
const LINKS = ['cardUid', 'recurringUid'] as const;
type Link = (typeof LINKS)[number];
type Links = Pick<Priority, Link>;

/** Whether two rows hold the same card or the same recurring priority. A null link matches nothing. */
export function sharesLink(a: Links, b: Links): boolean {
  return LINKS.some((f) => a[f] != null && a[f] === b[f]);
}

const hasLink = (p: Links) => LINKS.some((f) => p[f] != null);

/** Whether the server holds the row: its uid is one of `storedUids`. A row with none is new. */
const isStored = (p: Priority, storedUids: ReadonlySet<string | null>) => p.uid != null && storedUids.has(p.uid);

/**
 * The first text row that holds a non-null `cardUid` or `recurringUid` an earlier text row also
 * holds, where either of the two is new to the server (its uid isn't in `storedUids`), with the
 * link it repeats; null when none. The PUT refuses such a list. A repeat between two rows the
 * server holds is left to `dedupeLinks`, so a list a device got from the server is never refused.
 */
export function repeatedLink(rows: Priority[], storedUids: ReadonlySet<string | null>): { position: number; field: Link } | null {
  const written = rows.filter(hasText);
  for (const [i, p] of written.entries()) {
    for (const field of LINKS) {
      const repeats = (q: Priority) => q[field] != null && q[field] === p[field] && !(isStored(p, storedUids) && isStored(q, storedUids));
      if (written.slice(0, i).some(repeats)) return { position: p.position, field };
    }
  }
  return null;
}

/**
 * One text row per non-null `cardUid` and per non-null `recurringUid`. Of the text rows that
 * share one, the row the server holds (its uid in `storedUids`) stays, else the first, at the
 * first of their places, and the others go: sessions, or another device, may already point at
 * the stored row's uid. Emptied rows are left as they are (`dropShadowedLinks`); the caller
 * renumbers.
 */
export function dedupeLinks(rows: Priority[], storedUids: ReadonlySet<string | null>): Priority[] {
  return LINKS.reduce((list, field) => {
    const groups = new Map<string, Priority[]>();
    for (const p of list) {
      const link = p[field];
      if (link == null || !hasText(p)) continue;
      groups.set(link, [...(groups.get(link) ?? []), p]);
    }
    return list.flatMap((p) => {
      const link = hasText(p) ? p[field] : null;
      if (link == null) return [p];
      const group = groups.get(link)!;
      return p === group[0] ? [group.find((q) => isStored(q, storedUids)) ?? p] : [];
    });
  }, rows);
}

/** An emptied row loses a non-null `cardUid` or `recurringUid` a text row of the list holds: that row is the card's or the routine's now. */
export function dropShadowedLinks(rows: Priority[]): Priority[] {
  const written = rows.filter(hasText);
  return rows.map((p) => {
    if (hasText(p)) return p;
    return LINKS.reduce((row, f) => (row[f] != null && written.some((q) => q[f] === row[f]) ? { ...row, [f]: null } : row), p);
  });
}

/** The rows with a uid, by it; a row with none (never written in) matches nothing. */
function byUid(rows: Priority[]): Map<string | null, Priority> {
  return new Map(rows.filter((p) => p.uid != null).map((p) => [p.uid, p]));
}

/** Whether this device changed any merged field of a row since `base`. A link it sent differently changes nothing. */
function changed(base: Priority, mine: Priority): boolean {
  return MERGE_FIELDS.some((f) => mine[f] !== base[f]);
}

/** `row` with the stored value of each fixed field. */
function keepFixed(stored: Priority, row: Priority): Priority {
  return FIXED_FIELDS.reduce((out, f) => ({ ...out, [f]: stored[f] }), row);
}

/** The stored row with each merged field this device changed since `base` taken from `mine`. */
function mergeRow(stored: Priority, base: Priority, mine: Priority): Priority {
  return MERGE_FIELDS.reduce((row, f) => (mine[f] === base[f] ? row : { ...row, [f]: mine[f] }), stored);
}

/**
 * `mine`, a list this device built on `base`, laid onto `stored`, the server's copy, as the
 * changes made here since `base`, so a save keeps what another device did meanwhile to the rows
 * and fields this one left alone. Rows match by uid.
 *
 * - A row in all three keeps the stored value of each field (`MERGED`) this device left as it
 *   was in `base`, and takes this device's value of each `'merge'` field it changed: the same
 *   field changed on both goes to this device. A `'fixed'` field keeps the stored value.
 * - A row in `mine` and `stored` but not in `base` is this device's as it is, its fixed fields
 *   as stored.
 * - A row this device removed (in `base`, not in `mine`) goes. One another device removed (in
 *   `base`, not in `stored`) stays gone, unless this device changed it.
 * - A row added here (in neither) stays. So does one another device added since `base` (only in
 *   `stored`): where a row added here has its text (`sameText`) and links to nothing, and the
 *   stored row has no recurring priority (a card it may hold, since the server makes one on a
 *   save with `cards`), the stored row takes that row's place and the one added here goes, so
 *   two devices that both took the left-open offer store one set. Two rows of one text on one
 *   device's list stay two. Another device's other new rows take this device's first rows never
 *   written in (an emptied row still stands for its item), else go at the end.
 *
 * This device's order wins. Then only a row with text stays ticked; one text row per card and
 * per recurring priority stays, the stored one where there is one (`dedupeLinks`), which also
 * meets two devices that placed the same card; an emptied row loses a link a text row holds
 * (`dropShadowedLinks`); past `MAX_PRIORITIES` another device's rows that went at the end are
 * left off; and the rows are numbered from 1. The server stores what this returns, and the day
 * store shows it while the save is out.
 */
export function mergePriorities(stored: Priority[], base: Priority[], mine: Priority[]): Priority[] {
  const storedBy = byUid(stored);
  const baseBy = byUid(base);
  const mineUids = new Set(mine.map((p) => p.uid));
  const theirs = stored.filter((p) => p.uid != null && !baseBy.has(p.uid) && !mineUids.has(p.uid));
  const placed = new Set<Priority>();
  const out: Priority[] = [];
  for (const m of mine) {
    const s = storedBy.get(m.uid);
    const b = baseBy.get(m.uid);
    if (s && b) out.push(mergeRow(s, b, m));
    else if (s) out.push(keepFixed(s, m));
    else if (b) {
      if (changed(b, m)) out.push(m);
    } else {
      // The server may have made a card for the other device's row when it stored it (`cards`), so
      // a card there doesn't keep the two apart; a recurring priority, which only a client sets, does.
      const pairs = (t: Priority) => !placed.has(t) && t.recurringUid == null && sameText(t.text) === sameText(m.text);
      const twin = hasText(m) && !hasLink(m) ? theirs.find(pairs) : undefined;
      if (twin) placed.add(twin);
      out.push(twin ?? m);
    }
  }
  for (const t of theirs) {
    if (placed.has(t)) continue;
    const free = out.findIndex(isFree);
    if (free === -1) out.push(t);
    else out[free] = t;
  }
  const ticked = out.map((p) => ({ ...p, done: hasText(p) && p.done }));
  const linked = dropShadowedLinks(dedupeLinks(ticked, new Set(storedBy.keys())));
  return linked.slice(0, MAX_PRIORITIES).map((p, i) => ({ ...p, position: i + 1 }));
}
