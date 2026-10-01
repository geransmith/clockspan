/**
 * A value the server owns (a day, the settings, the running session), kept as two parts: what
 * the server has confirmed, and the changes this device has made since that the server hasn't
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
 * Pure and immutable: every function on a `Tracked` returns a new one. `apply` and `commit` must
 * be pure too (no clock reads inside them), since the shown value is worked out again whenever it
 * changes. `serial()`, the stores' write queue, lives here too.
 */

interface Pending<T> {
  id: number;
  apply: (value: T) => T;
}

export interface Tracked<T> {
  /**
   * The server's answers in the order they arrived: a read's copy, with each save's answer laid
   * on it since. Not always what the server holds now: a save's answer can be older than a read
   * that landed before it. Undefined until the first answer.
   */
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
 * `settle` for a server that answers with the whole value (the running session, all the
 * settings): its answer becomes the confirmed value, loaded or not, so a save made before the
 * first read answered still shows.
 */
export function settleWith<T>(t: Tracked<T>, ids: readonly number[], value: T): Tracked<T> {
  return { confirmed: value, pending: t.pending.filter((p) => !ids.includes(p.id)), version: t.version + 1 };
}

/**
 * A change the server made and confirmed without this store asking (the timer started or
 * finished a session, old days were deleted): laid onto the confirmed value, and a read already
 * out is older.
 */
export function confirm<T>(t: Tracked<T>, change: (confirmed: T) => T): Tracked<T> {
  return { ...t, confirmed: t.confirmed === undefined ? undefined : change(t.confirmed), version: t.version + 1 };
}

/**
 * A read sent at `sentVersion` answered `value`. `stale`: the server confirmed a change after it
 * was sent, so the answer is older than that change and may not include it. A stale answer is
 * dropped, except on a value never loaded, which takes it anyway since there is nothing better
 * to show.
 */
export function fetched<T>(t: Tracked<T>, sentVersion: number, value: T): { next: Tracked<T>; stale: boolean } {
  const stale = t.version !== sentVersion;
  if (stale && t.confirmed !== undefined) return { next: t, stale };
  return { next: { ...t, confirmed: value }, stale };
}

/** Runs `job` once the jobs queued before it on the same key have settled. */
type Queue = <R>(job: () => Promise<R>, key?: string) => Promise<R>;

/**
 * A store's write queue: each job starts once the one before it on its key has answered, failed
 * or not, so the server takes the writes in the order they were made (two in flight could land
 * the other way round and leave it on the older value). Keys don't wait on each other, and a key
 * with nothing left to run is forgotten, so one per session doesn't pile up.
 */
export function serial(): Queue {
  const tails = new Map<string, Promise<unknown>>();
  return (job, key = '') => {
    const next = (tails.get(key) ?? Promise.resolve()).catch(() => {}).then(job);
    tails.set(key, next);
    const forget = () => {
      if (tails.get(key) === next) tails.delete(key);
    };
    void next.then(forget, forget);
    return next;
  };
}
