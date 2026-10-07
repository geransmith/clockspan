/** The same text typed twice, whatever its case or spacing: the key repeats are merged by. */
export function sameText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}
