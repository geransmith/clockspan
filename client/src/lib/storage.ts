/**
 * localStorage that never throws. Storage can be missing or blocked (private mode, a full
 * quota), and everything the app keeps there is a nicety. A failure reads as "nothing stored".
 *
 * Most of it belongs to the device: the theme, the settings tab last picked, which timer end
 * already chimed. `USER_KEYS` hold the state of the user the app is open for, and `adoptUser`
 * drops them when the user changes (a sign-out, or someone else signing in on this browser): an
 * alarm key names a date and a minute, Start fresh names a date and the break-over mark names a
 * break's start, so another user's would silence this one's, the morning offer's answers name a
 * date and recurring priorities, so another user's could hide this one's items, and the capture
 * box's category is another user's uid.
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

/** A stored JSON value, or null when there is none or it does not parse. */
export function readStoredJson(key: string): unknown {
  const raw = readStored(key);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** Removes every key under `prefix` but `keep`, so a store kept per day never grows. */
export function pruneStored(prefix: string, keep: string): void {
  try {
    // Backwards: removing a key renumbers the ones after it.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(prefix) && k !== keep) localStorage.removeItem(k);
    }
  } catch {
    // Not pruned; see above.
  }
}

/** The id of the user the app is open for in this browser, or '' when no one is signed in. Every tab follows it. */
export const AUTH_USER_KEY = 'focus:auth-user';
const storedUser = (id: number | null): string => (id === null ? '' : String(id));

/**
 * The stored values (a key, or a prefix) that hold one user's state. A new one joins this list.
 * `captureCategory` is the category the board's capture box last picked (its uid, '' for none).
 * `recurringAnswered` is the recurring priorities the morning offer was answered for today on this
 * device, added or not (`writeAnswered` in `lib/recurring.ts`).
 */
export const USER_KEYS = {
  alarms: 'focus:alarms:',
  leftOpenDismissed: 'focus:left-open-dismissed',
  breakOver: 'focus:break-over',
  captureCategory: 'focus:capture-category',
  recurringAnswered: 'focus:recurring-answered',
} as const;

/**
 * Records who the app is open for (null: no one) and drops the last user's `USER_KEYS` when it
 * changes. With no one recorded yet (the first load after an upgrade) it only records, so an
 * alarm that already rang does not ring again.
 */
export function adoptUser(id: number | null): void {
  const next = storedUser(id);
  const last = readStored(AUTH_USER_KEY);
  if (next === last) return;
  if (last) for (const key of Object.values(USER_KEYS)) pruneStored(key, '');
  writeStored(AUTH_USER_KEY, next);
}

/** True when `AUTH_USER_KEY` names someone other than `id` (null: no one). A key never written counts as no one else. */
export function otherUserStored(id: number | null): boolean {
  const stored = readStored(AUTH_USER_KEY);
  return stored !== null && stored !== storedUser(id);
}
