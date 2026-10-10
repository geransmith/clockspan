/**
 * A value the server owns (a day, the settings, the running session, the board), kept as two parts: what
 * the server has confirmed, and the changes this device has made since that the server hasn't
 * confirmed yet. The screen shows the confirmed value with the pending changes laid over it in
 * the order they were made. That split carries every rule the stores need:
 *
 * - A save that fails just leaves `pending`, so the screen falls back to what the server has,
 *   with any other change still on its way laid over it. Nothing has to remember an old value
 *   to put back, and two failures in a row can't put back each other's guesses.
 * - A read's answer replaces `confirmed` and never a pending change, which stays on top. Every
 *   answer names the user's revision on the server, and `revision` keeps the highest one laid on
 *   `confirmed`: an answer below it is older than what is shown and is dropped, and one the same
 *   as `confirmed` changes nothing.
 *
 * Pure and immutable: no function changes a `Tracked`; each returns a new one, or the same one
 * when nothing changed (`fetched`). `apply` and `commit` must be pure too (no clock reads inside
 * them), since the shown value is worked out again whenever it changes. `serial()`, the stores'
 * write queue, lives here too, and `whenIdle()`, which waits for every write still on its way.
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
  /** The highest revision named by the answers laid on `confirmed` (`Answer.revision`); 0 until one is. */
  revision: number;
}

/** Nothing known yet. */
export function untracked<T>(): Tracked<T> {
  return { confirmed: undefined, pending: [], revision: 0 };
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
 * The server answered for the changes `ids`, or never did: they leave `pending`, and the screen
 * falls back to the confirmed value. A save's answer then goes on with `confirm` or `settleWith`.
 */
export function settle<T>(t: Tracked<T>, ids: readonly number[]): Tracked<T> {
  return { ...t, pending: t.pending.filter((p) => !ids.includes(p.id)) };
}

/**
 * `settle` for a server that answers with the whole value (the running session, all the
 * settings, the board): its answer becomes the confirmed value, loaded or not, so a save made
 * before the first read answered still shows. An answer below the revision held is older than
 * the value shown, so only the changes leave.
 */
export function settleWith<T>(t: Tracked<T>, ids: readonly number[], value: T, revision: number): Tracked<T> {
  const settled = settle(t, ids);
  return revision < t.revision ? settled : { ...settled, confirmed: value, revision };
}

/**
 * A change the server confirmed at `revision` (a save's answer, or a change it made without this
 * store asking: the timer started or finished a session, old days were deleted), laid onto the
 * confirmed value whatever its revision, since it carries one part of the value and may be the
 * newest copy of it. A read already out answers below it. With `(d) => d` it only raises the
 * revision: a refusal, which the server numbers too.
 */
export function confirm<T>(t: Tracked<T>, change: (confirmed: T) => T, revision: number): Tracked<T> {
  return { ...t, confirmed: t.confirmed === undefined ? undefined : change(t.confirmed), revision: Math.max(t.revision, revision) };
}

/**
 * A read answered `value` at `revision`. `stale`: the answer is below the revision held, so it is
 * older than a change already laid on and may not include it. A stale answer is dropped, except
 * on a value never loaded, which takes it anyway since there is nothing better to show. An answer
 * that prints the same as the confirmed value changes nothing and `t` itself comes back, so a
 * store that works out what it shows per tracked value (useDay's `shownDays`, the memos in
 * useSettings, useTimer and useBoard) keeps that value's identity, lists and all. The server
 * builds days, settings and sessions in one fixed key order, and commits spread onto them in
 * place, so a key-order difference only costs a replace.
 */
export function fetched<T>(t: Tracked<T>, value: T, revision: number): { next: Tracked<T>; stale: boolean } {
  const stale = revision < t.revision;
  if (t.confirmed !== undefined && (stale || JSON.stringify(value) === JSON.stringify(t.confirmed))) return { next: t, stale };
  return { next: { ...t, confirmed: value, revision: Math.max(t.revision, revision) }, stale };
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
    const next = whileUnsettled((tails.get(key) ?? Promise.resolve()).catch(() => {}).then(job));
    tails.set(key, next);
    const forget = () => {
      if (tails.get(key) === next) tails.delete(key);
    };
    void next.then(forget, forget);
    return next;
  };
}

/** Every write still on its way, in any store: what `whenIdle` waits for. */
const unsettled = new Set<Promise<unknown>>();

/** `write`, counted among the writes `whenIdle` waits for until it settles. */
export function whileUnsettled<T>(write: Promise<T>): Promise<T> {
  unsettled.add(write);
  const drop = () => unsettled.delete(write);
  void write.then(drop, drop);
  return write;
}

/**
 * Resolves once every write `serial()` queued or `whileUnsettled` counted has settled, saved or
 * not, those added while it waits included. A sign-out waits on it, or a write still waiting
 * would go out after the session ended, or never. Each request has its own timeout, so the wait
 * ends.
 */
export async function whenIdle(): Promise<void> {
  while (unsettled.size > 0) await Promise.allSettled(unsettled);
}
