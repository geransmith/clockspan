import type { CardId } from '../types';

/** A title for every card id; adding an id to CARD_IDS without one is a type error. */
export const CARD_TITLES: Record<CardId, string> = {
  timeclock: 'Timeclock',
  priorities: 'Top priorities',
  timer: 'Focus timer',
  log: 'Day log',
  retro: 'Retrospective',
};
