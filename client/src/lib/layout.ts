import { CARD_DEFAULT_VISIBLE, CARD_IDS } from '../../../shared/settings.js';
import type { CardId, Settings } from '../types';

/** A title for every card id; adding an id to CARD_IDS without one is a type error. */
export const CARD_TITLES: Record<CardId, string> = {
  timeclock: 'Timeclock',
  priorities: 'Top priorities',
  timer: 'Focus timer',
  log: 'Day log',
  retro: 'Retrospective',
};

/** Drop unknown ids, append missing ones with their default — mirrors the server merge. */
export function normalizeLayout(layout: Settings['layout'] | undefined): Settings['layout'] {
  const known = new Set<CardId>(CARD_IDS);
  const seen = new Set<CardId>();
  const out: Settings['layout'] = [];
  for (const item of layout ?? []) {
    if (!known.has(item.id) || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push({ id: item.id, visible: item.visible !== false });
  }
  for (const id of CARD_IDS) if (!seen.has(id)) out.push({ id, visible: CARD_DEFAULT_VISIBLE[id] });
  return out;
}
