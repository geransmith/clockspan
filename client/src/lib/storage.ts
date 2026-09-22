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
