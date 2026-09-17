import { CELEBRATION_EMOJI, CELEBRATION_PHRASES } from './copy';

export interface Celebration {
  emoji: string;
  phrase: string;
}

/** Small integer hash so one seed gives independent emoji and phrase picks. */
function hash(n: number, salt: number): number {
  let h = (Math.floor(n) ^ salt) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Deterministic per seed (the clock-out instant), so the notice doesn't change on every
 * render or reload, but a new clock-out gets a new pick.
 */
export function pickCelebration(seed: number): Celebration {
  return {
    emoji: CELEBRATION_EMOJI[hash(seed, 0x9e37) % CELEBRATION_EMOJI.length]!,
    phrase: CELEBRATION_PHRASES[hash(seed, 0x7f4a) % CELEBRATION_PHRASES.length]!,
  };
}
