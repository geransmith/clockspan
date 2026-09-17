import { useMemo, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { pickBurst } from '../lib/celebrate';

interface Props {
  /** Picks the emoji and their flight; the parent keys the burst by it. */
  seed: number;
  /** Where it starts: the element that was ticked or the notice that appeared. */
  anchor: DOMRect;
  big?: boolean;
}

/** How long one burst lives; the parent drops it after this. */
export const BURST_MS = 1800;

/**
 * A handful of emoji flying up from `anchor` and fading out. Rendered on `document.body`
 * because cards clip their overflow. Nothing under reduced motion: the app's rule turns
 * every animation off, which would leave the emoji sitting in a clump.
 */
export function Burst({ seed, anchor, big = false }: Props) {
  const pieces = useMemo(() => pickBurst(seed, big ? 14 : 8), [seed, big]);
  if (reducedMotion()) return null;
  const reach = big ? 140 : 90;
  const style: CSSProperties = { left: anchor.left + anchor.width / 2, top: anchor.top + anchor.height / 2 };
  return createPortal(
    <span className={`burst${big ? ' burst--big' : ''}`} style={style} aria-hidden="true">
      {pieces.map((p, i) => (
        <span
          key={i}
          className="burst-emoji"
          style={{ '--dx': `${Math.round(p.dx * reach)}px`, '--dy': `${-Math.round(p.dy * reach)}px`, '--delay': `${p.delay}s`, '--rot': `${Math.round(p.rot * 90)}deg` } as CSSProperties}
        >
          {p.emoji}
        </span>
      ))}
    </span>,
    document.body,
  );
}

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && 'matchMedia' in window && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
