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

export interface BurstPiece {
  emoji: string;
  /** Sideways drift, -1..1 of the burst's reach. */
  dx: number;
  /** Rise, 0.5..1 of the reach. */
  dy: number;
  /** Start delay, 0..0.3 s. */
  delay: number;
  /** Spin, -1..1 of a quarter turn. */
  rot: number;
}

/** The pieces of one burst: `count` emoji with their flight, deterministic per seed. */
export function pickBurst(seed: number, count: number): BurstPiece[] {
  const out: BurstPiece[] = [];
  for (let i = 0; i < count; i++) {
    const h = hash(seed, 0x51ed + i * 0x9e37);
    const unit = (shift: number) => ((h >>> shift) & 0xff) / 255;
    out.push({
      emoji: CELEBRATION_EMOJI[h % CELEBRATION_EMOJI.length]!,
      dx: unit(8) * 2 - 1,
      dy: 0.5 + unit(16) * 0.5,
      delay: unit(24) * 0.3,
      rot: unit(4) * 2 - 1,
    });
  }
  return out;
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
