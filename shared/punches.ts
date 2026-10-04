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
 * A list's rows and their times as one string. Every fetch of a day builds a new list, so a
 * copy the server sent again with nothing changed only matches the one before by value.
 */
export function punchesKey(punches: readonly Punch[]): string {
  return punches.map((p) => `${p.position}:${p.at ?? ''}`).join();
}

/** The same rows at the same times (`punchesKey`). */
export function samePunches(a: readonly Punch[], b: readonly Punch[]): boolean {
  return punchesKey(a) === punchesKey(b);
}

/**
 * Punch rows a day can hold: clock in, lunch out and in, 18 extra out/in pairs and the clock out.
 * The server refuses more, and the card stops offering Add extra out / in at it.
 */
export const MAX_PUNCHES = 40;
