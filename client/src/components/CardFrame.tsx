import type { CSSProperties, ReactNode } from 'react';
import { CARD_TITLES } from '../lib/layout';
import type { CardId } from '../types';
import { CardShell } from './CardShell';

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
 * The element a card sits in, with the id `jumpTo` scrolls to. Drag and drop (`SortableCards`)
 * adds its node ref, transform and grip listeners; the plain list leaves them out.
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
  return (
    <div ref={nodeRef} style={style} className="sortable" id={`card-${card.id}`}>
      <CardShell title={CARD_TITLES[card.id]} aside={card.aside} customize={card.customize && { ...card.customize, handleProps }}>
        {card.body}
      </CardShell>
    </div>
  );
}
