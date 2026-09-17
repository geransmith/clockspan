import type { Priority } from '../types';
import { GENTLE_WARNINGS } from './copy';

/** Mirrors the server cap. */
export const MAX_PRIORITIES = 20;

/**
 * The server stores only the rows that exist; the card shows at least `count` rows and
 * every stored row beyond that.
 */
export function padPriorities(rows: Priority[], count: number): Priority[] {
  const byPos = new Map(rows.map((r) => [r.position, r]));
  const n = Math.min(MAX_PRIORITIES, Math.max(count, ...rows.map((r) => r.position)));
  const out: Priority[] = [];
  for (let position = 1; position <= n; position++) {
    const r = byPos.get(position);
    out.push({ position, text: r?.text ?? '', done: Boolean(r?.done && r.text.trim()) });
  }
  return out;
}

/** Adding past this many rows gets a gentle warning first. */
export function warnThreshold(count: number): number {
  return Math.max(3, count);
}

/** A random warning, never the same one twice in a row. */
export function pickWarning(rng: () => number = Math.random, avoid?: string): string {
  const pool = GENTLE_WARNINGS.length > 1 && avoid ? GENTLE_WARNINGS.filter((w) => w !== avoid) : GENTLE_WARNINGS;
  return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))]!;
}
