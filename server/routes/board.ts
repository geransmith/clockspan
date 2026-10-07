import { Router } from 'express';
import type { DB } from '../db.js';
import { currentUser } from '../auth/middleware.js';
import { refuse } from '../refuse.js';
import { boardJson, createCard, linkedFrom, openCount, placeCard, removeCard } from '../board.js';
import { isOneOf } from '../validate.js';
import { getOwnedByUid, parseCategoryUid, uidRouter, UID_RE, type CategoryRow } from './shared.js';
import { hasText } from '../../shared/priorities.js';
import { sameText } from '../../shared/text.js';
import { isValidDateKey } from '../../shared/dates.js';
import { BOARD_LIMITS, CATEGORY_COLORS, LIMITS, type Board, type OpenLane } from '../../shared/api.js';

const FULL = `The board holds at most ${BOARD_LIMITS.openCards} cards in Later and Next.`;
const NO_TITLE = 'A card needs a title.';
const BAD_LANE = 'lane must be later or next.';
const NO_NAME = 'A category needs a name.';
const BAD_COLOR = `color must be one of ${CATEGORY_COLORS.join(', ')}.`;
const NAME_TAKEN = 'There is already a category with that name.';
const NAME_REMOVED = 'A removed category has that name. Restore it by its id.';
const CATEGORIES_FULL = `The board keeps at most ${BOARD_LIMITS.categories} categories.`;
const CATEGORIES_STORED = `The board keeps at most ${BOARD_LIMITS.categoriesStored} categories, removed ones included.`;

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

/** A category's name: trimmed, inner spaces collapsed, cut to `LIMITS.categoryName`; null for anything but text. */
function parseName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().replace(/\s+/g, ' ').slice(0, LIMITS.categoryName).trim();
  return name === '' ? null : name;
}

/** The user's categories, removed ones included. */
function categoryRows(db: DB, userId: number): CategoryRow[] {
  return db.prepare(`SELECT * FROM categories WHERE user_id = ?`).all(userId) as CategoryRow[];
}

/**
 * The categories' routes under `/board/categories`. A removed category is archived, never
 * deleted, so the time logged under it keeps its name, and a POST of its uid brings it back.
 * Names are unique among the categories in use whatever their case or spacing (`sameText`), and
 * a new uid can't take a removed one's name either: the client brings that one back by its uid
 * instead.
 */
function categoriesRouter(db: DB): Router {
  const { router: r, owned } = uidRouter(db, 'categories');

  // A new category, or a removed one brought back under its uid with the name and colour sent.
  // A uid in use already answers the board as it is (a retry). The 100 counts the categories in
  // use, a removed one brought back included; the 1000 counts every one stored, for a new one.
  r.post('/', (req, res) => {
    const userId = currentUser(req).id;
    const body = req.body as { uid?: unknown; name?: unknown; color?: unknown };
    if (typeof body.uid !== 'string' || !UID_RE.test(body.uid)) return refuse(res, 400, 'uid must be a category id.');
    const name = parseName(body.name);
    if (name === null) return refuse(res, 400, NO_NAME);
    const color = body.color;
    if (!isOneOf(CATEGORY_COLORS, color)) return refuse(res, 400, BAD_COLOR);
    const uid = body.uid.toLowerCase();
    const outcome = db.transaction((): 'kept' | 'restored' | 'created' | { error: string } => {
      const all = categoryRows(db, userId);
      const own = all.find((c) => c.uid === uid);
      if (own && own.archived_at == null) return 'kept';
      const named = all.filter((c) => c.uid !== uid && sameText(c.name) === sameText(name));
      if (named.some((c) => c.archived_at == null)) return { error: NAME_TAKEN };
      if (!own && named.length > 0) return { error: NAME_REMOVED };
      if (all.filter((c) => c.archived_at == null).length >= BOARD_LIMITS.categories) return { error: CATEGORIES_FULL };
      if (own) {
        db.prepare(`UPDATE categories SET name = ?, color = ?, archived_at = NULL WHERE id = ?`).run(name, color, own.id);
        return 'restored';
      }
      if (all.length >= BOARD_LIMITS.categoriesStored) return { error: CATEGORIES_STORED };
      db.prepare(`INSERT INTO categories (user_id, uid, name, color) VALUES (?, ?, ?, ?)`).run(userId, uid, name, color);
      return 'created';
    })();
    if (typeof outcome === 'object') return refuse(res, 400, outcome.error);
    res.status(outcome === 'created' ? 201 : 200).json(boardJson(db, userId) satisfies Board);
  });

  // A new name or colour; a field left out keeps its value. The name is checked against the
  // other categories in use.
  r.patch('/:uid', (req, res) => {
    const category = owned(res);
    const body = req.body as { name?: unknown; color?: unknown };
    const name = body.name === undefined ? category.name : parseName(body.name);
    if (name === null) return refuse(res, 400, NO_NAME);
    const color = body.color === undefined ? category.color : body.color;
    if (!isOneOf(CATEGORY_COLORS, color)) return refuse(res, 400, BAD_COLOR);
    const others = categoryRows(db, category.user_id).filter((c) => c.uid !== category.uid && c.archived_at == null);
    if (others.some((c) => sameText(c.name) === sameText(name))) return refuse(res, 400, NAME_TAKEN);
    db.prepare(`UPDATE categories SET name = ?, color = ? WHERE id = ?`).run(name, color, category.id);
    res.json(boardJson(db, category.user_id) satisfies Board);
  });

  // Removed in Settings: archived, so the rows, cards and sessions that name it keep its name.
  r.delete('/:uid', (_req, res) => {
    const category = owned(res);
    db.prepare(`UPDATE categories SET archived_at = COALESCE(archived_at, ?) WHERE id = ?`).run(Date.now(), category.id);
    res.json(boardJson(db, category.user_id) satisfies Board);
  });

  return r;
}

/**
 * The board: `GET /board`, the cards' own routes under `/board/cards` and the categories' under
 * `/board/categories`, where every `/:uid` route works on the caller's own row or answers 404
 * (`uidRouter`). Every write answers the whole board. Rows reach a card only through a
 * priorities save (`mirrorCards`), and a card reaches Done only through a ticked row.
 */
export function boardRouter(db: DB): Router {
  const r = Router();

  r.get('/', (req, res) => {
    res.json(boardJson(db, currentUser(req).id) satisfies Board);
  });

  const { router: cards, owned } = uidRouter(db, 'board_cards');

  // A new card, or an existing one placed (a park: the board takes a row of today's list back
  // under the card the row is linked to). Placing takes the card out of Done, and the new title
  // and category (a category left out keeps the card's), and marks it handled. The cap counts
  // only a card new to Later and Next.
  cards.post('/', (req, res) => {
    const user = currentUser(req);
    const body = req.body as { uid?: unknown; title?: unknown; categoryUid?: unknown; lane?: unknown; before?: unknown };
    if (typeof body.uid !== 'string' || !UID_RE.test(body.uid)) return refuse(res, 400, 'uid must be a card id.');
    const title = parseTitle(body.title);
    if (title === null) return refuse(res, 400, NO_TITLE);
    const category = parseCategoryUid(body.categoryUid);
    if ('error' in category) return refuse(res, 400, category.error);
    const lane = body.lane;
    if (!isOpenLane(lane)) return refuse(res, 400, BAD_LANE);
    const place = parseBefore(body.before);
    if ('error' in place) return refuse(res, 400, place.error);
    const uid = body.uid.toLowerCase();
    const outcome = db.transaction((): 'created' | 'placed' | 'full' => {
      const card = getOwnedByUid(db, 'board_cards', user.id, uid);
      if ((!card || card.lane === 'done') && openCount(db, user.id) >= BOARD_LIMITS.openCards) return 'full';
      if (!card) {
        createCard(db, user.id, { uid, title, categoryUid: category.categoryUid ?? null }, lane, place.before ?? null, Date.now());
        return 'created';
      }
      const categoryUid = category.categoryUid === undefined ? card.category_uid : category.categoryUid;
      db.prepare(`UPDATE board_cards SET title = ?, category_uid = ?, untouched = 0 WHERE id = ?`).run(title, categoryUid, card.id);
      placeCard(db, user.id, card, lane, place.before ?? null);
      return 'placed';
    })();
    if (outcome === 'full') return refuse(res, 400, FULL);
    res.status(outcome === 'created' ? 201 : 200).json(boardJson(db, user.id) satisfies Board);
  });

  // An edit made on the board: the title, the category, a move to Later or Next (out of Done,
  // the correction of a mistaken tick), or `before` alone to reorder its lane. While a row on the
  // client's today or a later day is linked to the card, that row decides it, so the edit is
  // refused: it comes from a copy older than the list (another device moved the card onto it).
  cards.patch('/:uid', (req, res) => {
    const card = owned(res);
    const body = req.body as { today?: unknown; title?: unknown; categoryUid?: unknown; lane?: unknown; before?: unknown };
    if (!isValidDateKey(body.today)) return refuse(res, 400, 'today must be a date (YYYY-MM-DD).');
    const title = body.title === undefined ? undefined : parseTitle(body.title);
    if (title === null) return refuse(res, 400, NO_TITLE);
    const category = parseCategoryUid(body.categoryUid);
    if ('error' in category) return refuse(res, 400, category.error);
    const lane = body.lane;
    if (lane !== undefined && !isOpenLane(lane)) return refuse(res, 400, BAD_LANE);
    const place = parseBefore(body.before);
    if ('error' in place) return refuse(res, 400, place.error);
    if (linkedFrom(db, card.user_id, card.uid, body.today)) return refuse(res, 409, "That card is on today's list or a later one.");
    // A card in Done stays there unless a lane is named; `before` alone reorders an open lane.
    const to = lane ?? (card.lane === 'done' ? undefined : card.lane);
    const moves = to !== undefined && (to !== card.lane || place.before !== undefined);
    const categoryUid = category.categoryUid === undefined ? card.category_uid : category.categoryUid;
    const outcome = db.transaction((): 'full' | 'saved' => {
      if (moves && card.lane === 'done' && openCount(db, card.user_id) >= BOARD_LIMITS.openCards) return 'full';
      db.prepare(`UPDATE board_cards SET title = COALESCE(?, title), category_uid = ?, untouched = 0 WHERE id = ?`).run(title ?? null, categoryUid, card.id);
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
  r.use('/categories', categoriesRouter(db));
  return r;
}
