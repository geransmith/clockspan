import type { Punch } from './api.js';

/**
 * A punch row's kind is its position's parity (even in, odd out), so the server stores it from
 * the order and the client never has to send one. What each position means is on `Punch`.
 */
export function kindForPosition(position: number): Punch['kind'] {
  return position % 2 === 0 ? 'in' : 'out';
}

/**
 * A list's rows and their times as one string. A save's answer, or a fetch that changed something
 * else in the day, brings a new list with the same times, which matches the one before only by
 * value.
 */
export function punchesKey(punches: readonly Punch[]): string {
  return punches.map((p) => `${p.position}:${p.at ?? ''}`).join();
}

/**
 * A punch save laid onto the stored rows as the changes made since `base`, the rows the sender
 * built `list` on: each row takes the sent time where it differs from the base and the stored one
 * otherwise, so a punch another device saved meanwhile stays. A pair added or removed on either
 * side (the lengths differ), or no base (curl), leaves the list as sent.
 */
export function mergePunches(stored: readonly Punch[], base: readonly Punch[] | null, list: Punch[]): Punch[] {
  if (!base || base.length !== list.length || stored.length !== list.length) return list;
  return list.map((p, i) => (p.at === base[i]!.at ? { ...p, at: stored[i]!.at } : p));
}

/**
 * Punch rows a day can hold: clock in, lunch out and in, 18 extra out/in pairs and the clock out.
 * The server refuses more, and the card stops offering Add extra out / in at it.
 */
export const MAX_PUNCHES = 40;
