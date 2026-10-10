import { LIMITS } from './api.js';

/**
 * The key two texts are compared by, whatever their case or spacing: category names, a plan seed
 * against a day's rows, and Review's grouping by text.
 */
export function sameText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * `text` cut to `max` UTF-16 units (what `LIMITS` and an input's `maxLength` count), with a
 * surrogate left alone (one the cut split included) replaced, as SQLite would store it. Every cut
 * of user text to a limit goes through it.
 */
export function cutText(text: string, max: number): string {
  return text.slice(0, max).replace(/\p{Cs}/gu, '\uFFFD');
}

/**
 * A category's name as it is stored: trimmed, inner spaces collapsed, cut to
 * `LIMITS.categoryName`; empty for blank text. The server stores what this gives, and the client
 * shows a new or renamed category that way before the server has answered.
 */
export function categoryName(text: string): string {
  return cutText(text.trim().replace(/\s+/g, ' '), LIMITS.categoryName).trim();
}

/**
 * A task's name as it is stored: trimmed and cut to `LIMITS.priorityText`, with no space left at
 * the cut; empty for blank text. The list save and the board's routes both store what this gives.
 */
export function taskTitle(text: string): string {
  return cutText(text.trim(), LIMITS.priorityText).trim();
}

/**
 * A task's note as it is stored: control characters dropped but for line breaks and tabs, cut to
 * `LIMITS.itemNote`, a surrogate left alone (one the cut split included) replaced, and never
 * trimmed, so a line break just typed stays; '' is no note. The list save and the item PATCH store
 * what this gives, and the note box sends it, so a full list stays under the server's body limit.
 */
export function taskNote(text: string): string {
  return cutText(text.replace(/(?![\n\t])\p{Cc}/gu, ''), LIMITS.itemNote);
}

/** Whether a stored note says anything: one of spaces and line breaks alone counts as none. */
export const hasNote = (note: string): boolean => note.trim() !== '';
