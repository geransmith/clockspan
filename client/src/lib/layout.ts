import type { CardId, Settings } from '../types';

type Layout = Settings['layout'];

/** A title for every card id; adding an id to CARD_IDS without one is a type error. */
export const CARD_TITLES: Record<CardId, string> = {
  timeclock: 'Timeclock',
  priorities: 'Top priorities',
  timer: 'Focus timer',
  log: 'Day log',
  retro: 'Retrospective',
};

/**
 * The layout with the visible card at `from` moved to `to`, both counted among the visible cards
 * (the order the sheet shows); the hidden cards follow them. Null when nothing would move.
 */
export function moveCard(layout: Layout, from: number, to: number): Layout | null {
  const visible = layout.filter((l) => l.visible);
  if (from === to || to < 0 || to >= visible.length) return null;
  visible.splice(to, 0, ...visible.splice(from, 1));
  return [...visible, ...layout.filter((l) => !l.visible)];
}

/** The layout with one card shown or hidden, in place. */
export function setCardVisible(layout: Layout, id: CardId, visible: boolean): Layout {
  return layout.map((l) => (l.id === id ? { ...l, visible } : l));
}
