import type { Priority } from '../types';
import { newTaskRow } from './priorities';

/**
 * What a row put on a day's list from elsewhere starts from: its task, its name and category, and
 * the note and counts the server gave its source row, which the new row shows until its save
 * answers. A row carried over is its own seed.
 */
export type PrioritySeed = Pick<Priority, 'uid' | 'text' | 'categoryUid' | 'note' | 'listed' | 'earlier' | 'logged'>;

/** The row `seed` puts on a list, added `now`: its own task, with its source row's note and counts until the save answers. */
export function seedRow(seed: PrioritySeed, now: number): Omit<Priority, 'position'> {
  const { uid, note, listed, earlier, logged } = seed;
  return { ...newTaskRow(seed.text, seed.categoryUid, now), uid, note, listed, earlier, logged };
}
