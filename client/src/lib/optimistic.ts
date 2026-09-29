/**
 * A value the server owns (a day, the settings, the running session), kept as two parts: what
 * the server last confirmed, and the changes this device has made since that the server hasn't
 * confirmed yet. The screen shows the confirmed value with the pending changes laid over it in
 * the order they were made. That split carries every rule the stores need:
 *
 * - A save that fails just leaves `pending`, so the screen falls back to what the server has,
 *   with any other change still on its way laid over it. Nothing has to remember an old value
 *   to put back, and two failures in a row can't put back each other's guesses.
 * - A read's answer replaces `confirmed` and never a pending change, which stays on top. Only an
 *   answer older than a change the server has since confirmed is dropped: `version` moves with
 *   every confirmed change, and a read carries the version it was sent at.
 *
 * Pure and immutable: every function returns a new `Tracked`. `apply` and `commit` must be pure
 * too (no clock reads inside them), since the shown value is worked out again whenever it changes.
 */

export interface Pending<T> {
  id: number;
  apply: (value: T) => T;
}

export interface Tracked<T> {
  /** The server's last word; undefined until the first answer. */
  confirmed: T | undefined;
  /** Changes not confirmed yet, oldest first. */
  pending: readonly Pending<T>[];
  /** Moves with every change the server confirms (a save's answer, a change it made itself). */
  version: number;
}

/** Nothing known yet. */
export function untracked<T>(): Tracked<T> {
  return { confirmed: undefined, pending: [], version: 0 };
}

/** What the screen shows: the confirmed value with the pending changes over it; undefined until the first answer. */
export function shown<T>(t: Tracked<T>): T | undefined {
  if (t.confirmed === undefined) return undefined;
  let value: T = t.confirmed;
  for (const p of t.pending) value = p.apply(value);
  return value;
}

/** A change made on this device, shown at once and kept on top until the server answers for it. */
export function addPending<T>(t: Tracked<T>, id: number, apply: (value: T) => T): Tracked<T> {
  return { ...t, pending: [...t.pending, { id, apply }] };
}

/**
 * The server answered for the changes `ids`: they leave `pending`. With `commit` (it saved them)
 * the confirmed value takes the server's answer; without (it refused, or never answered) the
 * screen falls back to the confirmed value.
 */
export function settle<T>(t: Tracked<T>, ids: readonly number[], commit?: (confirmed: T) => T): Tracked<T> {
  const pending = t.pending.filter((p) => !ids.includes(p.id));
  return commit ? confirm({ ...t, pending }, commit) : { ...t, pending };
}

/**
 * A change the server made and confirmed without this store asking (the timer finished a
 * session, a break started): laid onto the confirmed value, and a read already out is older.
 */
export function confirm<T>(t: Tracked<T>, change: (confirmed: T) => T): Tracked<T> {
  return { ...t, confirmed: t.confirmed === undefined ? undefined : change(t.confirmed), version: t.version + 1 };
}

/**
 * A read sent at `sentVersion` answered `value`. It lands unless the server confirmed a change
 * after it was sent, which it may not include. A value never loaded takes the answer anyway,
 * since there is nothing better to show, and `again` asks for a fresh copy that has the change.
 */
export function fetched<T>(t: Tracked<T>, sentVersion: number, value: T): { next: Tracked<T>; again: boolean } {
  const stale = t.version !== sentVersion;
  if (stale && t.confirmed !== undefined) return { next: t, again: false };
  return { next: { ...t, confirmed: value }, again: stale };
}
