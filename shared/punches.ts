import type { Punch } from './api.js';

/**
 * Punch rows as both sides read them: position 0 clocks in, 1 and 2 are lunch out and in, 3+
 * are extra out/in pairs, and the last row (an odd position ≥ 3) is the clock out. A row's kind
 * is its position's parity, so the server stores it from the order and the client never has to
 * send one.
 */
export function kindForPosition(position: number): Punch['kind'] {
  return position % 2 === 0 ? 'in' : 'out';
}

/**
 * The same rows at the same times. Every fetch of a day builds a new list, so a copy the
 * server sent again with nothing changed is only equal to the one before by value.
 */
export function samePunches(a: readonly Punch[], b: readonly Punch[]): boolean {
  return a.length === b.length && a.every((p, i) => p.position === b[i]?.position && p.at === b[i]?.at);
}
