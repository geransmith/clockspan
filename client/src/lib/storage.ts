/**
 * localStorage that never throws. Storage can be missing or blocked (private mode, a full
 * quota), and everything the app keeps there is a nicety: which alarms already fired, which
 * timer end already chimed, the settings tab last open. A failure reads as "nothing stored".
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
