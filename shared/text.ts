import { LIMITS } from './api.js';

/**
 * The key two texts are compared by, whatever their case or spacing: category names, a plan seed
 * against a day's rows, and Review's grouping by text.
 */
export function sameText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * A category's name as it is stored: trimmed, inner spaces collapsed, cut to
 * `LIMITS.categoryName`; empty for blank text. The server stores what this gives, and the client
 * shows a new or renamed category that way before the server has answered.
 */
export function categoryName(text: string): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, LIMITS.categoryName).trim();
}

/**
 * A task's name as it is stored: trimmed and cut to `LIMITS.priorityText`, with no space left at
 * the cut; empty for blank text. The list save and the board's routes both store what this gives.
 */
export function taskTitle(text: string): string {
  return text.trim().slice(0, LIMITS.priorityText).trim();
}

/**
 * A task's note as it is stored: control characters dropped but for line breaks and tabs, cut to
 * `LIMITS.itemNote`, a surrogate left alone (one the cut split included) replaced, and never
 * trimmed, so a line break just typed stays; '' is no note. The list save and the item PATCH store
 * what this gives, and the note box sends it, so a full list stays under the server's body limit.
 */
export function taskNote(text: string): string {
  return text
    .replace(/(?![\n\t])\p{Cc}/gu, '')
    .slice(0, LIMITS.itemNote)
    .replace(/\p{Cs}/gu, '\uFFFD');
}
