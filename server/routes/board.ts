import { Router } from 'express';
import type { DB } from '../db.js';
import { currentUser } from '../auth/middleware.js';
import { refuse, STALE_CLIENT } from '../refuse.js';
import { boardJson } from '../board.js';
import { isOneOf } from '../validate.js';
import { uidRouter, UID_RE, type CategoryRow } from './shared.js';
import { categoryName, sameText } from '../../shared/text.js';
import { BOARD_LIMITS, CATEGORY_COLORS, type Board } from '../../shared/api.js';

const NO_NAME = 'A category needs a name.';
const BAD_COLOR = `color must be one of ${CATEGORY_COLORS.join(', ')}.`;
const NAME_TAKEN = 'There is already a category with that name.';
const NAME_REMOVED = 'A removed category has that name. Restore it by its id.';
const CATEGORIES_FULL = `The board keeps at most ${BOARD_LIMITS.categories} categories.`;
const CATEGORIES_STORED = `The board keeps at most ${BOARD_LIMITS.categoriesStored} categories, removed ones included.`;

/** A category's name as stored (`categoryName`); null for anything but text, or blank text. */
function parseName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = categoryName(raw);
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

  // Removed in Settings: archived, so the tasks and sessions that name it keep its name.
  r.delete('/:uid', (_req, res) => {
    const category = owned(res);
    db.prepare(`UPDATE categories SET archived_at = COALESCE(archived_at, ?) WHERE id = ?`).run(Date.now(), category.id);
    res.json(boardJson(db, category.user_id) satisfies Board);
  });

  return r;
}

/**
 * The board: `GET /board`, and the categories' routes under `/board/categories`, where every
 * `/:uid` route works on the caller's own category or answers 404 (`uidRouter`). The tasks' own
 * routes are under `/items` (`routes/items.ts`). Every write answers the whole board.
 */
export function boardRouter(db: DB): Router {
  const r = Router();

  r.get('/', (req, res) => {
    res.json(boardJson(db, currentUser(req).id) satisfies Board);
  });

  r.use('/categories', categoriesRouter(db));
  // A page loaded before tasks were stored once still sends its card and recurring writes here.
  // A plain 404 would read as done to its Delete, so it is told to reload instead.
  r.use(['/cards', '/recurring'], (_req, res) => refuse(res, 409, STALE_CLIENT));
  return r;
}
