/**
 * localStorage that never throws. Storage can be missing or blocked (private mode, a full
 * quota), and everything the app keeps there is a nicety. A failure reads as "nothing stored".
 *
 * Most of it belongs to the device: the theme, the settings tab last picked, which timer end
 * already chimed. `USER_KEYS` hold the state of the user the app is open for; `adoptUser` drops
 * them when that user changes.
 */
export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not kept; see above.
  }
}

const DAY_SET_RE = /^(\d{4}-\d{2}-\d{2}) (.*)$/;

/**
 * The set kept under `key` for `date`, stored as "YYYY-MM-DD a,b" (so an item holds no comma).
 * Empty for another date, nothing stored or anything else, so a new day starts with none.
 */
export function readDaySet(key: string, date: string): Set<string> {
  const m = DAY_SET_RE.exec(readStored(key) ?? '');
  if (!m || m[1] !== date) return new Set();
  return new Set(m[2]!.split(',').filter((item) => item !== ''));
}

/**
 * Adds `items` to the set kept under `key` for `date` and returns it. It adds to what is stored
 * now, not to a copy read earlier: another tab of this browser shares the key, and what it added
 * stays.
 */
export function addToDaySet(key: string, date: string, items: Iterable<string>): Set<string> {
  const set = readDaySet(key, date);
  for (const item of items) set.add(item);
  writeStored(key, `${date} ${[...set].join(',')}`);
  return set;
}

/** Removes every key under `prefix`. */
export function pruneStored(prefix: string): void {
  try {
    // Backwards: removing a key renumbers the ones after it.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(prefix)) localStorage.removeItem(k);
    }
  } catch {
    // Not pruned; see above.
  }
}

/** The id of the user the app is open for in this browser, or '' when no one is signed in. Every tab follows it. */
export const AUTH_USER_KEY = 'focus:auth-user';
const storedUser = (id: number | null): string => (id === null ? '' : String(id));

/** The stored values that hold one user's state, each dropped as a prefix. A new one joins this list. */
export const USER_KEYS = {
  /**
   * Today's fired alarm keys (`useAlarms`), each naming an alarm and a minute: another user's
   * would silence this one's. As a prefix it also takes the `focus:alarms:<date>` keys an
   * earlier version kept.
   */
  alarms: 'focus:alarms',
  /** The date Start Fresh was pressed: another user's would hide this one's "Still Open From …" and "Up Next". */
  leftOpenDismissed: 'focus:left-open-dismissed',
  /** The start of the break whose "Break's Over" rang: another user's would silence this one's. */
  breakOver: 'focus:break-over',
  /** The category the board columns' boxes last picked ('' for none): another user's uid. */
  captureCategory: 'focus:capture-category',
  /** The recurring priorities the morning offer was answered for today (`useRecurringAnswered`): another user's uids. */
  recurringAnswered: 'focus:recurring-answered',
} as const;

/**
 * Records who the app is open for (null: no one) and drops `USER_KEYS` when that changes, from
 * no one too: a page left open after a sign-out may have written one before it reloaded. With
 * nothing recorded yet (the first load after an upgrade) it only records, so an alarm that
 * already rang does not ring again.
 */
export function adoptUser(id: number | null): void {
  const next = storedUser(id);
  const last = readStored(AUTH_USER_KEY);
  if (next === last) return;
  if (last !== null) for (const key of Object.values(USER_KEYS)) pruneStored(key);
  writeStored(AUTH_USER_KEY, next);
}

/** True when `AUTH_USER_KEY` names someone other than `id` (null: no one). A key never written counts as no one else. */
export function otherUserStored(id: number | null): boolean {
  const stored = readStored(AUTH_USER_KEY);
  return stored !== null && stored !== storedUser(id);
}
