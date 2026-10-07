/**
 * The board's cards as stored: what the board routes (`routes/board.ts`), a priorities save
 * (`mirrorCards`) and the prune (`retention.ts`) write, and the board the API answers with, its
 * categories and recurring priorities included. A card belongs to its user, and rows point at
 * it by its uid (`priorities.card_uid`, a soft link). In progress is never stored: it is today's
 * open rows, which the client matches to cards by `cardUid`. A card's latest linked day is the
 * latest day whose list holds a row linked to it, with text or emptied; only a save of that
 * day's list changes the card.
 */
import { randomBytes } from 'node:crypto';
import type { DB } from './db.js';
import { getOwnedByUid, type CardRow, type CategoryRow, type RecurringRow } from './routes/shared.js';
import { hasText } from '../shared/priorities.js';
import { addDays, DAY_MS } from '../shared/dates.js';
import { BOARD_LIMITS, type Board, type BoardCard, type Category, type OpenLane, type Priority, type Recurring } from '../shared/api.js';

/** The uids of a lane's cards in their order. */
function laneOrder(db: DB, userId: number, lane: OpenLane): string[] {
  const rows = db.prepare(`SELECT uid FROM board_cards WHERE user_id = ? AND lane = ? ORDER BY position, id`).all(userId, lane) as { uid: string }[];
  return rows.map((c) => c.uid);
}

/** Numbers the given cards 1..n in this order. */
function writeOrder(db: DB, userId: number, uids: string[]): void {
  const set = db.prepare(`UPDATE board_cards SET position = ? WHERE user_id = ? AND uid = ?`);
  uids.forEach((uid, i) => set.run(i + 1, userId, uid));
}

/** Numbers a lane's cards 1..n: `first`, cards of that lane, at the top in this order, then the rest as they were. */
export function renumber(db: DB, userId: number, lane: OpenLane, first: readonly string[] = []): void {
  writeOrder(db, userId, [...first, ...laneOrder(db, userId, lane).filter((uid) => !first.includes(uid))]);
}

/** Cards in Later and Next, which `BOARD_LIMITS.openCards` caps. Done and In progress don't count. */
export function openCount(db: DB, userId: number): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM board_cards WHERE user_id = ? AND lane <> 'done'`).get(userId) as { n: number }).n;
}

/** Whether a row on `from`'s list or a later day's is linked to the card, with text or emptied. */
export function linkedFrom(db: DB, userId: number, uid: string, from: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM priorities p JOIN days d ON d.id = p.day_id WHERE d.user_id = ? AND p.card_uid = ? AND d.date >= ? LIMIT 1`)
      .get(userId, uid, from) !== undefined
  );
}

/**
 * The card goes to `lane`, before `before` there, or at the end when that names no card of the
 * lane (null, another lane's, itself); out of Done if it was there. The lane it left is
 * renumbered.
 */
export function placeCard(db: DB, userId: number, card: CardRow, lane: OpenLane, before: string | null): void {
  db.prepare(`UPDATE board_cards SET lane = ?, done_at = NULL WHERE id = ?`).run(lane, card.id);
  const order = laneOrder(db, userId, lane).filter((uid) => uid !== card.uid);
  const at = before == null ? -1 : order.indexOf(before);
  order.splice(at === -1 ? order.length : at, 0, card.uid);
  writeOrder(db, userId, order);
  if (card.lane !== lane && card.lane !== 'done') renumber(db, userId, card.lane);
}

/** A card the board made (capture, or a new card for a done item), handled from the start, placed in `lane` before `before`. */
export function createCard(
  db: DB,
  userId: number,
  card: Pick<BoardCard, 'uid' | 'title' | 'categoryUid'>,
  lane: OpenLane,
  before: string | null,
  now: number,
): void {
  const { uid, title, categoryUid } = card;
  db.prepare(`INSERT INTO board_cards (user_id, uid, title, category_uid, lane, position, created_at, untouched) VALUES (?, ?, ?, ?, ?, 0, ?, 0)`).run(
    userId,
    uid,
    title,
    categoryUid,
    lane,
    now,
  );
  placeCard(db, userId, getOwnedByUid(db, 'board_cards', userId, uid)!, lane, before);
}

/** Deletes the card and closes the gap in its lane. The rows linked to it keep their `cardUid`, now linked to nothing. */
export function removeCard(db: DB, userId: number, card: CardRow): void {
  db.prepare(`DELETE FROM board_cards WHERE id = ?`).run(card.id);
  if (card.lane !== 'done') renumber(db, userId, card.lane);
}

/** Each linked card's latest day, and whether a row of its on that day has text. */
function latestLinks(db: DB, userId: number): Map<string, { date: string; text: boolean }> {
  const rows = db
    .prepare(
      `SELECT p.card_uid AS card, d.date, p.text FROM priorities p JOIN days d ON d.id = p.day_id WHERE d.user_id = ? AND p.card_uid IS NOT NULL ORDER BY d.date DESC`,
    )
    .all(userId) as { card: string; date: string; text: string }[];
  const links = new Map<string, { date: string; text: boolean }>();
  for (const row of rows) {
    const link = links.get(row.card) ?? links.set(row.card, { date: row.date, text: false }).get(row.card)!;
    if (row.date === link.date && hasText(row)) link.text = true;
  }
  return links;
}

/** The user's categories in the order they were made, removed ones included: past time keeps its name. */
function categoriesJson(db: DB, userId: number): Category[] {
  const rows = db.prepare(`SELECT * FROM categories WHERE user_id = ? ORDER BY id`).all(userId) as CategoryRow[];
  return rows.map((c) => ({ uid: c.uid, name: c.name, color: c.color, archived: c.archived_at != null }));
}

/** ISO weekdays (Monday 1 to Sunday 7) as the `recurring` table stores them: bit 0 for Monday. */
export function weekdayMask(weekdays: readonly number[]): number {
  return weekdays.reduce((mask, day) => mask | (1 << (day - 1)), 0);
}

/** The ISO weekdays in a `recurring` mask, ascending. */
export function weekdaysOf(mask: number): number[] {
  return [1, 2, 3, 4, 5, 6, 7].filter((day) => mask & (1 << (day - 1)));
}

/** The user's recurring priorities in the order they were made, the order the offer lists them in. */
function recurringJson(db: DB, userId: number): Recurring[] {
  const rows = db.prepare(`SELECT * FROM recurring WHERE user_id = ? ORDER BY id`).all(userId) as RecurringRow[];
  return rows.map((r) => ({ uid: r.uid, title: r.title, categoryUid: r.category_uid, weekdays: weekdaysOf(r.weekdays) }));
}

/**
 * The user's board: Later and Next in order, then the cards done in the last
 * `doneWindowDays`, newest first, the categories and the recurring priorities. `listDate` and
 * `held` are read from the rows on every call, so neither can drift from the lists.
 */
export function boardJson(db: DB, userId: number, now: number = Date.now()): Board {
  const rows = db
    .prepare(
      `SELECT * FROM board_cards WHERE user_id = ? AND (lane <> 'done' OR done_at >= ?)
       ORDER BY CASE lane WHEN 'later' THEN 0 WHEN 'next' THEN 1 ELSE 2 END, position, done_at DESC, id`,
    )
    .all(userId, now - BOARD_LIMITS.doneWindowDays * DAY_MS) as CardRow[];
  const links = latestLinks(db, userId);
  const cards = rows.map((c): BoardCard => {
    const link = links.get(c.uid);
    return {
      uid: c.uid,
      title: c.title,
      categoryUid: c.category_uid,
      lane: c.lane,
      position: c.position,
      createdAt: c.created_at,
      doneAt: c.done_at,
      listDate: link?.date ?? null,
      held: c.untouched === 1 && link?.text === false,
    };
  });
  return { cards, categories: categoriesJson(db, userId), recurring: recurringJson(db, userId) };
}

export interface MirrorOptions {
  /** Make a card for each non-recurring text row with none: the client's `cards`, set while the board is on and the list's day is today or later. */
  makeCards: boolean;
  /** Cards a board action handled through their rows: marked handled, and left where the board put them when their row goes. */
  touched: ReadonlySet<string>;
}

/**
 * Keeps each board card in step with its latest linked row, inside the priorities PUT's
 * transaction, before `list` (the merged list) replaces `stored`. First, every card `touched`
 * names is marked handled (untouched = 0). With `makeCards`, a non-recurring text row with no
 * card gets a new one, whose uid is written onto the row, and a row gaining text whose cardUid
 * names no card gets it back under that uid, under the cap on Later and Next; either takes the
 * row's title and category. Whatever `makeCards` is, only what this save changed is copied onto
 * a card, and only from its latest linked day: a row gaining text (new to the list, or typed
 * into again after it was emptied) gives its title and category, and its lane by the tick (open
 * goes to Next, at the top unless it was in Next already); new text gives the title, a new
 * category the category; a tick moves it to Done, an untick to the top of Next. An emptied
 * row changes nothing: an untouched card reads as `held` meanwhile. A card whose row
 * went from the list is deleted while untouched, unless `touched` names it; a handled one stays,
 * and goes back to Done if it was taken out of it for this row (open, in Next) and its latest
 * remaining row with text is ticked. Recurring rows never have a card. Returns the list to store.
 */
export function mirrorCards(db: DB, userId: number, date: string, stored: Priority[], list: Priority[], now: number, opts: MirrorOptions): Priority[] {
  const handled = db.prepare(`UPDATE board_cards SET untouched = 0 WHERE user_id = ? AND uid = ?`);
  for (const uid of opts.touched) handled.run(userId, uid);
  const isLatest = (uid: string) => !linkedFrom(db, userId, uid, addDays(date, 1));
  const update = db.prepare(`UPDATE board_cards SET title = ?, lane = ?, position = ?, done_at = ? WHERE id = ?`);
  const recategorise = db.prepare(`UPDATE board_cards SET category_uid = ? WHERE id = ?`);
  const storedText = new Map(stored.filter(hasText).map((p) => [p.uid, p]));
  // Cards that went to Next, in row order: a save puts them at the top.
  const top: string[] = [];
  let open = openCount(db, userId);
  let changed = false;

  /** A card for `row` under `uid`, in Done or at the top of Next by its tick; false when Later and Next are full. */
  const make = (row: Priority, uid: string, untouched: boolean): boolean => {
    if (open >= BOARD_LIMITS.openCards) return false;
    db.prepare(
      `INSERT INTO board_cards (user_id, uid, title, category_uid, lane, position, created_at, done_at, untouched) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    ).run(userId, uid, row.text.trim(), row.categoryUid, row.done ? 'done' : 'next', now, row.done ? now : null, untouched ? 1 : 0);
    if (!row.done) {
      top.push(uid);
      open++;
    }
    changed = true;
    return true;
  };
  /**
   * The card takes `row`'s title, and its lane by the tick: Done (its doneAt kept if it was
   * there already), or Next, at the top unless `keepPlace` and it is in Next already.
   */
  const follow = (card: CardRow, row: Priority, keepPlace: boolean) => {
    const title = row.text.trim();
    // Later and Next gain the card when it leaves Done and lose it when it goes there, so a card
    // made later in this save still finds them under the cap.
    if (card.lane === 'done' && !row.done) open++;
    else if (card.lane !== 'done' && row.done) open--;
    if (row.done) update.run(title, 'done', 0, card.lane === 'done' ? card.done_at : now, card.id);
    else if (keepPlace && card.lane === 'next') update.run(title, 'next', card.position, null, card.id);
    else {
      update.run(title, 'next', 0, null, card.id);
      top.push(card.uid);
    }
    changed = true;
  };

  const out = list.map((row): Priority => {
    if (row.recurringUid != null || !hasText(row)) return row;
    if (row.cardUid == null) {
      if (!opts.makeCards) return row;
      const uid = randomBytes(6).toString('hex');
      return make(row, uid, true) ? { ...row, cardUid: uid } : row;
    }
    if (!isLatest(row.cardUid)) return row;
    const card = getOwnedByUid(db, 'board_cards', userId, row.cardUid);
    const before = storedText.get(row.uid);
    if (!before) {
      // Gains text: new to this list, or typed into again after it was emptied.
      if (card) {
        follow(card, row, true);
        recategorise.run(row.categoryUid, card.id);
      } else if (opts.makeCards) make(row, row.cardUid, !opts.touched.has(row.cardUid));
    } else if (card) {
      if (row.done !== before.done) follow(card, row, false);
      else if (row.text !== before.text) db.prepare(`UPDATE board_cards SET title = ? WHERE id = ?`).run(row.text.trim(), card.id);
      if (row.categoryUid !== before.categoryUid) recategorise.run(row.categoryUid, card.id);
    }
    return row;
  });

  const onList = new Set(out.map((p) => p.cardUid));
  for (const s of stored) {
    const uid = s.cardUid;
    if (uid == null || onList.has(uid) || opts.touched.has(uid) || !isLatest(uid)) continue;
    const card = getOwnedByUid(db, 'board_cards', userId, uid);
    if (!card) continue;
    if (card.untouched === 1) {
      db.prepare(`DELETE FROM board_cards WHERE id = ?`).run(card.id);
      changed = true;
    } else if (hasText(s) && !s.done && card.lane === 'next' && latestTextTicked(db, userId, uid, date)) {
      // Taken out of Done for this row (a pull of a done card, say) and the row taken off again: back to Done.
      update.run(card.title, 'done', 0, now, card.id);
      changed = true;
    }
  }

  if (changed) {
    renumber(db, userId, 'later');
    renumber(db, userId, 'next', top);
  }
  return out;
}

/** Whether the latest row with text linked to the card, on a day before `date`, is ticked. */
function latestTextTicked(db: DB, userId: number, uid: string, date: string): boolean {
  const rows = db
    .prepare(
      `SELECT p.text, p.done FROM priorities p JOIN days d ON d.id = p.day_id WHERE d.user_id = ? AND p.card_uid = ? AND d.date < ? ORDER BY d.date DESC`,
    )
    .all(userId, uid, date) as { text: string; done: number }[];
  return rows.find(hasText)?.done === 1;
}
