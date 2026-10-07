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
 * it differs from the base its list was built on, else the stored one. A new `Priority` field
 * fails typecheck until it is listed here.
 */
export const MERGED: Record<MergedField, 'merge'> = { text: 'merge', done: 'merge', addedAt: 'merge' };
const FIELDS = Object.keys(MERGED) as MergedField[];

/** The rows with a uid, by it; a row with none (never written in) matches nothing. */
function byUid(rows: Priority[]): Map<string | null, Priority> {
  return new Map(rows.filter((p) => p.uid != null).map((p) => [p.uid, p]));
}

/** Whether this device changed any field of a row since `base`. */
function changed(base: Priority, mine: Priority): boolean {
  return FIELDS.some((f) => mine[f] !== base[f]);
}

/** The stored row with each field this device changed since `base` taken from `mine`. */
function mergeRow(stored: Priority, base: Priority, mine: Priority): Priority {
  return FIELDS.reduce((row, f) => (mine[f] === base[f] ? row : { ...row, [f]: mine[f] }), stored);
}

/**
 * `mine`, a list this device built on `base`, laid onto `stored`, the server's copy, as the
 * changes made here since `base`, so a save keeps what another device did meanwhile to the rows
 * and fields this one left alone. Rows match by uid.
 *
 * - A row in all three keeps the stored value of each field (`MERGED`) this device left as it
 *   was in `base`, and takes this device's value of each one it changed: the same field changed
 *   on both goes to this device.
 * - A row in `mine` and `stored` but not in `base` is this device's as it is.
 * - A row this device removed (in `base`, not in `mine`) goes. One another device removed (in
 *   `base`, not in `stored`) stays gone, unless this device changed it.
 * - A row added here (in neither) stays. So does one another device added since `base` (only in
 *   `stored`): where a row added here has its text (`sameText`), the stored row takes that row's
 *   place and the one added here goes, so two devices that both took the left-open offer store
 *   one set. Two rows of one text on one device's list stay two. Another device's other new rows
 *   take this device's first rows never written in (an emptied row still stands for its item),
 *   else go at the end.
 *
 * This device's order wins. Then the rows are numbered from 1, only a row with text stays
 * ticked, and past `MAX_PRIORITIES` another device's rows that went at the end are left off.
 * The server stores what this returns, and the day store shows it while the save is out.
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
    else if (s) out.push(m);
    else if (b) {
      if (changed(b, m)) out.push(m);
    } else {
      const twin = hasText(m) ? theirs.find((t) => !placed.has(t) && sameText(t.text) === sameText(m.text)) : undefined;
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
  return out.slice(0, MAX_PRIORITIES).map((p, i) => ({ ...p, position: i + 1, done: hasText(p) && p.done }));
}
