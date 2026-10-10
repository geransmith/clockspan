/**
 * The revisions this page's own writes were answered with, so the live stream can tell a change
 * made here from one made in another tab or on another device. The server moves a user's revision
 * by exactly one per write, so a span of revisions is all this page's only when it noted every
 * number in it. A write that never answered isn't noted, which costs one extra read and never
 * misses a change.
 */
const own = new Set<number>();

/** A write this page sent was answered at `revision` (`request()` in api.ts), a refusal's included. */
export function noteOwnWrite(revision: number): void {
  own.add(revision);
}

/** Whether a revision in (`after`, `upTo`] was another tab's or device's. Forgets what it noted up to `upTo`. */
export function changedElsewhere(after: number, upTo: number): boolean {
  let mine = 0;
  for (const r of own) {
    if (r > after && r <= upTo) mine++;
    if (r <= upTo) own.delete(r);
  }
  return mine < upTo - after;
}
