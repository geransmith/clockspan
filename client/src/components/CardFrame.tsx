import type { CSSProperties, ReactNode } from 'react';
import { CARD_TITLES } from '../lib/layout';
import type { CardId } from '../types';
import { ArrowDown, ArrowUp, EyeOff, Grip } from './Icons';

/** One card on the sheet, as both the plain list and the drag-and-drop one render it. */
export interface SheetCard {
  id: CardId;
  body: ReactNode;
  /** Extra content on the right of the title (the timeclock's state pill). */
  aside?: ReactNode;
  /** Set while customizing: the card's move and hide buttons. */
  customize?: { onHide: () => void; onMove: (dir: -1 | 1) => void; canUp: boolean; canDown: boolean };
}

/**
 * A sheet card: its title, aside and body, with the grip, move and hide buttons while
 * customizing, in the element `jumpTo` scrolls to. Drag and drop (`SortableCards`) adds its node
 * ref, transform and grip listeners; the plain list leaves them out.
 */
export function CardFrame({
  card,
  nodeRef,
  style,
  handleProps = {},
}: {
  card: SheetCard;
  nodeRef?: (el: HTMLElement | null) => void;
  style?: CSSProperties;
  handleProps?: Record<string, unknown>;
}) {
  const title = CARD_TITLES[card.id];
  const { customize } = card;
  return (
    <section ref={nodeRef} style={style} id={`card-${card.id}`} className={`card sheet-card${customize ? ' card--customize' : ''}`}>
      <header className="card-head">
        {customize && (
          <button className="btn btn-icon card-grip" {...handleProps} aria-label={`Drag to move ${title}`} title="Drag to reorder">
            <Grip />
          </button>
        )}
        <h2 className="card-title">{title}</h2>
        {card.aside && <div className="card-aside">{card.aside}</div>}
        {customize && (
          <div className="card-tools">
            <button className="btn btn-icon" onClick={() => customize.onMove(-1)} disabled={!customize.canUp} aria-label={`Move ${title} up`}>
              <ArrowUp />
            </button>
            <button className="btn btn-icon" onClick={() => customize.onMove(1)} disabled={!customize.canDown} aria-label={`Move ${title} down`}>
              <ArrowDown />
            </button>
            <button className="btn btn-icon" onClick={customize.onHide} aria-label={`Hide ${title}`} title="Hide">
              <EyeOff />
            </button>
          </div>
        )}
      </header>
      <div className="card-body">{card.body}</div>
    </section>
  );
}
