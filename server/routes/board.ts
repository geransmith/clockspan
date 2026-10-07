import { Router } from 'express';
import type { DB } from '../db.js';
import { currentUser } from '../auth/middleware.js';
import { refuse } from '../refuse.js';
import { boardJson, createCard, linkedFrom, openCount, placeCard, removeCard } from '../board.js';
import { getOwnedByUid, uidRouter, UID_RE } from './shared.js';
import { hasText } from '../../shared/priorities.js';
import { isValidDateKey } from '../../shared/dates.js';
import { BOARD_LIMITS, LIMITS, type Board, type OpenLane } from '../../shared/api.js';

const FULL = `The board holds at most ${BOARD_LIMITS.openCards} cards in Later and Next.`;
const NO_TITLE = 'A card needs a title.';
const BAD_LANE = 'lane must be later or next.';

/** A card's title: trimmed and cut to a priority's length; null for anything but text. */
function parseTitle(raw: unknown): string | null {
  return typeof raw === 'string' && hasText({ text: raw }) ? raw.trim().slice(0, LIMITS.priorityText) : null;
}

/** The lanes the board puts a card in; Done is reached only through a ticked row. */
function isOpenLane(raw: unknown): raw is OpenLane {
  return raw === 'later' || raw === 'next';
}

/** Where a card goes in its lane: before this card (lowercased), or at the end for null; undefined = not mentioned. */
function parseBefore(raw: unknown): { before: string | null | undefined } | { error: string } {
  if (raw == null) return { before: raw };
  if (typeof raw === 'string' && UID_RE.test(raw)) return { before: raw.toLowerCase() };
  return { error: 'before must be a card id or null.' };
}

/**
 * The board: `GET /board`, and the cards' own routes under `/board/cards`, where every `/:uid`
 * route works on the caller's own card or answers 404 (`uidRouter`). Every write answers the
 * whole board. Rows reach a card only through a priorities save (`mirrorCards`), and a card
 * reaches Done only through a ticked row.
 */
export function boardRouter(db: DB): Router {
  const r = Router();

  r.get('/', (req, res) => {
    res.json(boardJson(db, currentUser(req).id) satisfies Board);
  });

  const { router: cards, owned } = uidRouter(db, 'board_cards');

  // A new card, or an existing one placed (a park: the board takes a row of today's list back
  // under the card the row is linked to). Placing takes the card out of Done, and the new title,
  // and marks it handled. The cap counts only a card new to Later and Next.
  cards.post('/', (req, res) => {
    const user = currentUser(req);
    const body = req.body as { uid?: unknown; title?: unknown; lane?: unknown; before?: unknown };
    if (typeof body.uid !== 'string' || !UID_RE.test(body.uid)) return refuse(res, 400, 'uid must be a card id.');
    const title = parseTitle(body.title);
    if (title === null) return refuse(res, 400, NO_TITLE);
    const lane = body.lane;
    if (!isOpenLane(lane)) return refuse(res, 400, BAD_LANE);
    const place = parseBefore(body.before);
    if ('error' in place) return refuse(res, 400, place.error);
    const uid = body.uid.toLowerCase();
    const outcome = db.transaction((): 'created' | 'placed' | 'full' => {
      const card = getOwnedByUid(db, 'board_cards', user.id, uid);
      if ((!card || card.lane === 'done') && openCount(db, user.id) >= BOARD_LIMITS.openCards) return 'full';
      if (!card) {
        createCard(db, user.id, uid, title, lane, place.before ?? null, Date.now());
        return 'created';
      }
      db.prepare(`UPDATE board_cards SET title = ?, untouched = 0 WHERE id = ?`).run(title, card.id);
      placeCard(db, user.id, card, lane, place.before ?? null);
      return 'placed';
    })();
    if (outcome === 'full') return refuse(res, 400, FULL);
    res.status(outcome === 'created' ? 201 : 200).json(boardJson(db, user.id) satisfies Board);
  });

  // An edit made on the board: the title, a move to Later or Next (out of Done, the correction
  // of a mistaken tick), or `before` alone to reorder its lane. While a row on the client's today
  // or a later day is linked to the card, that row decides it, so the edit is refused: it comes
  // from a copy older than the list (another device moved the card onto it).
  cards.patch('/:uid', (req, res) => {
    const card = owned(res);
    const body = req.body as { today?: unknown; title?: unknown; lane?: unknown; before?: unknown };
    if (!isValidDateKey(body.today)) return refuse(res, 400, 'today must be a date (YYYY-MM-DD).');
    const title = body.title === undefined ? undefined : parseTitle(body.title);
    if (title === null) return refuse(res, 400, NO_TITLE);
    const lane = body.lane;
    if (lane !== undefined && !isOpenLane(lane)) return refuse(res, 400, BAD_LANE);
    const place = parseBefore(body.before);
    if ('error' in place) return refuse(res, 400, place.error);
    if (linkedFrom(db, card.user_id, card.uid, body.today)) return refuse(res, 409, "That card is on today's list or a later one.");
    // A card in Done stays there unless a lane is named; `before` alone reorders an open lane.
    const to = lane ?? (card.lane === 'done' ? undefined : card.lane);
    const moves = to !== undefined && (to !== card.lane || place.before !== undefined);
    const outcome = db.transaction((): 'full' | 'saved' => {
      if (moves && card.lane === 'done' && openCount(db, card.user_id) >= BOARD_LIMITS.openCards) return 'full';
      db.prepare(`UPDATE board_cards SET title = COALESCE(?, title), untouched = 0 WHERE id = ?`).run(title ?? null, card.id);
      if (moves) placeCard(db, card.user_id, card, to, place.before ?? null);
      return 'saved';
    })();
    if (outcome === 'full') return refuse(res, 400, FULL);
    res.json(boardJson(db, card.user_id) satisfies Board);
  });

  // The rows linked to the card keep their cardUid, linked to nothing: the board takes the card
  // off today's list and its later day's first, through priorities saves.
  cards.delete('/:uid', (_req, res) => {
    const card = owned(res);
    db.transaction(() => removeCard(db, card.user_id, card))();
    res.json(boardJson(db, card.user_id) satisfies Board);
  });

  r.use('/cards', cards);
  return r;
}
