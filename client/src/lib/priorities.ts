import type { Priority } from '../types';
import { COMPLETE_WARNINGS, GENTLE_WARNINGS, PROGRESS_WARNINGS } from './copy';

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
    out.push({ position, text: r?.text ?? '', done: Boolean(r?.done && r.text.trim()), uid: r?.uid ?? null, addedAt: r?.addedAt ?? null });
  }
  return out;
}

/** Adding past this many rows gets a gentle warning first. */
export function warnThreshold(count: number): number {
  return Math.max(3, count);
}

/** Which pool the warning comes from: nothing ticked yet, some ticked, or all of them. */
export type WarningKind = 'fresh' | 'progress' | 'complete';

export function warningKind(done: number, total: number): WarningKind {
  if (done <= 0) return 'fresh';
  return done >= total ? 'complete' : 'progress';
}

const POOLS: Record<WarningKind, readonly string[]> = {
  fresh: GENTLE_WARNINGS,
  progress: PROGRESS_WARNINGS,
  complete: COMPLETE_WARNINGS,
};

/** A random warning for the kind, never the same one twice in a row. */
export function pickWarning(kind: WarningKind, rng: () => number = Math.random, avoid?: string): string {
  const all = POOLS[kind];
  const pool = all.length > 1 && avoid ? all.filter((w) => w !== avoid) : all;
  return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))]!;
}

/**
 * Stable id for a priority so sessions can point at it after rows are renumbered. Twelve
 * hex chars from getRandomValues: randomUUID needs a secure context and a self-hosted
 * sheet on plain http isn't one.
 */
export function newUid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Where a priority added from the timer goes: the first empty row if there is one, else a
 * new row at the end. Returns the full list to save; null when the sheet is full.
 */
export function placePriority(rows: Priority[], count: number, text: string, uid: string, addedAt: number): Priority[] | null {
  const padded = padPriorities(rows, count);
  const empty = padded.find((p) => !p.text.trim());
  if (empty) return padded.map((p) => (p.position === empty.position ? { ...p, text, done: false, uid, addedAt } : p));
  if (padded.length >= MAX_PRIORITIES) return null;
  return [...padded, { position: padded.length + 1, text, done: false, uid, addedAt }];
}
