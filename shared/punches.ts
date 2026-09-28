/**
 * Punch rows as both sides read them: position 0 clocks in, 1 and 2 are lunch out and in, 3+
 * are extra out/in pairs, and the last row (an odd position ≥ 3) is the clock out. A row's kind
 * is its position's parity, so the server stores it from the order and the client never has to
 * send one.
 */
export function kindForPosition(position: number): 'in' | 'out' {
  return position % 2 === 0 ? 'in' : 'out';
}
