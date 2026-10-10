import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { BurstAt } from '../hooks/useCelebration';
import { pickBurst } from '../lib/celebrate';

interface Props {
  /** `useCelebration`'s burst: the seed picks the emoji and their flight, the anchor is where they start. Null draws nothing. */
  at: BurstAt | null;
  big?: boolean;
}

/**
 * A handful of emoji flying up from the anchor and fading out. Rendered on `document.body`
 * because cards clip their overflow. Keyed by the seed, so a new burst restarts the animation.
 */
export function Burst({ at, big = false }: Props) {
  if (!at) return null;
  const reach = big ? 140 : 90;
  const { anchor } = at;
  // Never closer to the top of the window than the emoji rise, or one from the running bar's Done flies off screen.
  const style: CSSProperties = { left: anchor.left + anchor.width / 2, top: Math.max(anchor.top + anchor.height / 2, reach) };
  return createPortal(
    <span key={at.seed} className={`burst${big ? ' burst--big' : ''}`} style={style} aria-hidden="true">
      {pickBurst(at.seed, big ? 14 : 8).map((p, i) => (
        <span
          key={i}
          className="burst-emoji"
          style={
            {
              '--dx': `${Math.round(p.dx * reach)}px`,
              '--dy': `${-Math.round(p.dy * reach)}px`,
              '--delay': `${p.delay}s`,
              '--rot': `${Math.round(p.rot * 90)}deg`,
            } as CSSProperties
          }
        >
          {p.emoji}
        </span>
      ))}
    </span>,
    document.body,
  );
}
