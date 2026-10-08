import type { Priority } from './api.js';

/** A row with something written in it; the others are the card's empty slots. */
export function hasText(p: { text: string }): boolean {
  return p.text.trim() !== '';
}

/** A row no task is on: the client pads a day's list with these, and the server stores none. A new priority goes only into one of these, or a new row. */
export function isFree(p: Priority): boolean {
  return p.uid == null && !hasText(p);
}

/** The fields only the server works out: never merged, and never read from a save. */
type ReadOnlyField = 'recurring' | 'archived' | 'listed' | 'earlier' | 'logged';
type MergedField = Exclude<keyof Priority, 'position' | 'uid' | ReadOnlyField>;

/**
 * The fields a save merges: this device's value where it differs from the base its list was built
 * on, else the stored one. A new `Priority` field fails typecheck until it is listed here or as
 * read only.
 */
const MERGED: Record<MergedField, 'merge'> = {
  text: 'merge',
  done: 'merge',
  addedAt: 'merge',
  categoryUid: 'merge',
};
const MERGE_FIELDS = Object.keys(MERGED) as MergedField[];

/** The rows with a uid, by it; a free row matches nothing. */
function byUid(rows: Priority[]): Map<string | null, Priority> {
  return new Map(rows.filter((p) => p.uid != null).map((p) => [p.uid, p]));
}

/** Whether this device changed any merged field of a row since `base`. */
function changed(base: Priority, mine: Priority): boolean {
  return MERGE_FIELDS.some((f) => mine[f] !== base[f]);
}

/** The stored row with each merged field this device changed since `base` taken from `mine`. */
function mergeRow(stored: Priority, base: Priority, mine: Priority): Priority {
  return MERGE_FIELDS.reduce((row, f) => (mine[f] === base[f] ? row : { ...row, [f]: mine[f] }), stored);
}

/**
 * `mine`, a list this device built on `base`, laid onto `stored`, the server's copy, as the
 * changes made here since `base`, so a save keeps what another device did meanwhile to the rows
 * and fields this one left alone. Rows match by uid, which is their task's.
 *
 * - A row in all three keeps the stored value of each field (`MERGED`) this device left as it
 *   was in `base`, and takes this device's value of each field it changed: the same field
 *   changed on both goes to this device.
 * - A row in `mine` and `stored` but not in `base` (both devices put the task on the list) is
 *   the stored row: the first save wins, so a copy behind can't undo a tick made since.
 * - A row this device removed (in `base`, not in `mine`) goes. One another device removed (in
 *   `base`, not in `stored`) stays gone, unless this device changed it.
 * - A row added here (in neither) stays. One another device added since `base` (only in
 *   `stored`) takes this device's first free row, else goes at the end.
 *
 * The read-only fields come from the stored row where there is one. This device's order wins,
 * only a row with text stays ticked, and the rows are numbered from 1, free rows included: the
 * list can run past `MAX_PRIORITIES` when another device's rows went at the end, which the server
 * refuses. The server stores what this returns, and the day store shows it while the save is out.
 */
export function mergePriorities(stored: Priority[], base: Priority[], mine: Priority[]): Priority[] {
  const storedBy = byUid(stored);
  const baseBy = byUid(base);
  const mineUids = new Set(mine.map((p) => p.uid));
  const theirs = stored.filter((p) => p.uid != null && !baseBy.has(p.uid) && !mineUids.has(p.uid));
  const out: Priority[] = [];
  for (const m of mine) {
    const s = storedBy.get(m.uid);
    const b = baseBy.get(m.uid);
    if (s) out.push(b ? mergeRow(s, b, m) : s);
    else if (!b || changed(b, m)) out.push(m);
  }
  for (const t of theirs) {
    const free = out.findIndex(isFree);
    if (free === -1) out.push(t);
    else out[free] = t;
  }
  return out.map((p, i) => ({ ...p, done: hasText(p) && p.done, position: i + 1 }));
}
