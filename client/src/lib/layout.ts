import { CARD_IDS, DEFAULT_SETTINGS } from '../../../shared/settings.js';
import type { CardId, Settings } from '../types';

export interface CardDef {
  id: CardId;
  title: string;
}

/** A title for every card id; adding an id to CARD_IDS without one is a type error. */
const CARD_TITLES: Record<CardId, string> = {
  timeclock: 'Timeclock',
  priorities: 'Top priorities',
  timer: 'Focus timer',
  log: 'Day log',
  retro: 'Retrospective',
};

/** Registry of cards in default order; all are visible by default. */
export const CARDS: CardDef[] = CARD_IDS.map((id) => ({ id, title: CARD_TITLES[id] }));

export const DEFAULT_LAYOUT: Settings['layout'] = DEFAULT_SETTINGS.layout;

export function cardTitle(id: CardId): string {
  return CARDS.find((c) => c.id === id)?.title ?? id;
}

/** Drop unknown ids, append missing ones visible — mirrors the server merge. */
export function normalizeLayout(layout: Settings['layout'] | undefined): Settings['layout'] {
  const known = new Set(CARDS.map((c) => c.id));
  const seen = new Set<CardId>();
  const out: Settings['layout'] = [];
  for (const item of layout ?? []) {
    if (!known.has(item.id) || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push({ id: item.id, visible: item.visible !== false });
  }
  for (const c of CARDS) if (!seen.has(c.id)) out.push({ id: c.id, visible: true });
  return out;
}
