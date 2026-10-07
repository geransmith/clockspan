import type { CardId, CardSide, Settings } from '../types';

type Layout = Settings['layout'];
type Entry = Layout[number];

/** A title for every card id; adding an id to CARD_IDS without one is a type error. */
export const CARD_TITLES: Record<CardId, string> = {
  timeclock: 'Timeclock',
  priorities: 'Top priorities',
  timer: 'Focus timer',
  log: 'Day log',
  retro: 'Retrospective',
};

/**
 * The window width from which the sheet has two columns. `styles.css` lays them out under the
 * same media query (`theme-css.test.ts` checks), and the sheet asks it when it mounts.
 */
export const SPLIT_QUERY = '(min-width: 1100px)';

/**
 * The layout with the visible card at `from` moved to `to`, both counted among the visible cards
 * of `side`'s column, or among all of them for one list (the order the sheet shows); the hidden
 * cards follow them. A column's cards take back the places they held among the visible ones, so
 * the other column's cards stay where they are. Null when nothing would move.
 */
export function moveCard(layout: Layout, from: number, to: number, side?: CardSide): Layout | null {
  const visible = layout.filter((l) => l.visible);
  const inStack = (l: Entry) => side === undefined || l.side === side;
  const stack = visible.filter(inStack);
  if (from === to || to < 0 || to >= stack.length) return null;
  stack.splice(to, 0, ...stack.splice(from, 1));
  let next = 0;
  return [...visible.map((l) => (inStack(l) ? stack[next++]! : l)), ...layout.filter((l) => !l.visible)];
}

/** The layout with one card shown or hidden, in place. */
export function setCardVisible(layout: Layout, id: CardId, visible: boolean): Layout {
  return layout.map((l) => (l.id === id ? { ...l, visible } : l));
}

/**
 * The layout with one card in the given column. It keeps its place in the order, so the
 * one-column sheet (a phone) doesn't change, and it lands among the other column's cards where
 * that order puts it.
 */
export function setCardSide(layout: Layout, id: CardId, side: CardSide): Layout {
  return layout.map((l) => (l.id === id ? { ...l, side } : l));
}

/** Each column's visible cards in the layout's order; null when one would be empty, so the sheet stays one list. */
export function splitColumns(layout: Layout): Record<CardSide, Layout> | null {
  const left = layout.filter((l) => l.visible && l.side === 'left');
  const right = layout.filter((l) => l.visible && l.side === 'right');
  return left.length > 0 && right.length > 0 ? { left, right } : null;
}
