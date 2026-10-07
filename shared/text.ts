import { LIMITS } from './api.js';

/** The same text typed twice, whatever its case or spacing: the key repeats are merged by. */
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
