import type { CardId, Settings } from '../types';

export interface CardDef {
  id: CardId;
  title: string;
}

/** Registry of cards. Order here is the default order; all are visible by default. */
export const CARDS: CardDef[] = [
  { id: 'timeclock', title: 'Timeclock' },
  { id: 'priorities', title: 'Top priorities' },
  { id: 'timer', title: 'Focus timer' },
  { id: 'log', title: 'Day log' },
  { id: 'retro', title: 'Retrospective' },
];

export const DEFAULT_LAYOUT: Settings['layout'] = CARDS.map((c) => ({ id: c.id, visible: true }));

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
