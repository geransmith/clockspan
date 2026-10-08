/**
 * The board's logic, with no React and no dnd-kit: which column each card and each of today's
 * rows shows in (`boardColumns`), what a move does and which store it writes (`planMove`), where a
 * drop lands and what a drag says (`dropTarget`, `withDrag`, `moveAnnouncement`), the cards the
 * left-open offer may bring back (`offeredLeftovers`), what New category makes of a name
 * (`categoryForName`, `nextColor`), and the board as a write shows it before the server answers
 * (`withCard`, `withPatch`, `withoutCard`, `withCategory`, `withCategoryPatch`, `withoutCategory`,
 * `withRecurring`, `withRecurringPatch`, `withoutRecurring`).
 *
 * In progress is never stored: it is today's open rows, matched to their cards by `cardUid`, so
 * the board and the sheet show one list. A card linked to a row of today's list shows where that
 * row says (open: In progress, ticked: Done, emptied: nowhere); any other card by `held`, then
 * `listDate` (a later day's list holds it: planned, in Next), then its lane.
 */
import type { CardPatch, CategoryPatch, NewCard, NewCategory, RecurringPatch } from '../api';
import { BOARD_LIMITS, CATEGORY_COLORS } from '../../../shared/api.js';
import { todayKey } from '../../../shared/dates.js';
import { hasText } from '../../../shared/priorities.js';
import { categoryName, sameText } from '../../../shared/text.js';
import type { Board, BoardCard, Category, CategoryColor, Day, OpenLane, Priority, Recurring } from '../types';
import { BOARD, BOARD_DRAG, DONE_STAYS } from './copy';
import { dayName } from './format';
import type { PrioritySeed } from './plan';
import { isOpen, isRecurring, newUid } from './priorities';

/** The board's four columns. Later and Next are card lanes; In progress and Done are mostly today's rows. */
export type ColumnId = 'later' | 'next' | 'progress' | 'done';

export interface BoardItem {
  /**
   * The React key, and what a move and the focus follow: `row:<date>:<row uid>` for today's rows
   * and an earlier day's ticked row with no card, `card:<card uid>` otherwise. Looked up, never
   * parsed.
   */
  id: string;
  title: string;
  column: ColumnId;
  /** The linked card when this device's copy has it; a row whose card a save just made shows with none until the next read. */
  card: BoardCard | null;
  /** The row on its day's list, for a row item. */
  row: Priority | null;
  /** The row's day; null for a card item. */
  date: string | null;
  /** The row's category, or the card's for a card item: what a pulled row or a done item's new card takes. */
  categoryUid: string | null;
  recurring: boolean;
  /** For a card off today's list that a later day's list holds (its `listDate`): shown in Next, and read-only but for Delete. */
  planned: string | null;
}

export interface BoardColumns {
  later: BoardItem[];
  next: BoardItem[];
  progress: BoardItem[];
  /** Today's ticked rows, then the cards done today, newest first. */
  doneToday: BoardItem[];
  /** Done earlier this week: newest day first. */
  doneEarlier: BoardItem[];
}

/** A row the server should make a card for: written, with no card yet, and not a recurring priority's. */
export function needsCard(p: Priority): boolean {
  return hasText(p) && p.cardUid == null && !isRecurring(p);
}

/** The card an item stands for: its own, else the one its row names (a card this copy doesn't have yet); null for a row with none. */
export function cardUidOf(item: BoardItem | undefined): string | null {
  return item?.card?.uid ?? item?.row?.cardUid ?? null;
}

/** The later day whose list holds the item's card, or null when none after `today` does. */
export function plannedFor(item: BoardItem, today: string): string | null {
  const day = item.card?.listDate;
  return day != null && day > today ? day : null;
}

/** Cards in Later and Next together, which the server caps at `BOARD_LIMITS.openCards`. */
export function boardFull(board: Board): boolean {
  return board.cards.filter((c) => c.lane !== 'done').length >= BOARD_LIMITS.openCards;
}

/** Where capture and Move to put a card: the top of Later, the end of Next. */
export function laneStart(columns: BoardColumns, lane: OpenLane): string | null {
  return lane === 'later' ? cardUidOf(columns.later[0]) : null;
}

const byPosition = (a: BoardCard, b: BoardCard) => a.position - b.position;
const doneTime = (c: BoardCard) => c.doneAt ?? 0;

export interface ColumnsInput {
  cards: BoardCard[];
  today: string;
  /** Today's list as the day store shows it. */
  todayRows: Priority[];
  /** This week's days before today. */
  earlierDays: Day[];
  /** The first instants of today and of its week (Monday): Done holds this week and clears on Monday. */
  todayStart: number;
  weekStart: number;
  /** Items shown in another column while a move that spans two stores is on its way, by item id. */
  moving?: ReadonlyMap<string, ColumnId>;
}

/**
 * What each column shows. A card linked to a row of today's list (text or emptied) shows only as
 * that row, so an emptied row shows nowhere, and so does its card; a `held` card shows nowhere on
 * any day. A card a later day's list holds is planned: in Next whatever its lane, after Next's own
 * cards when its lane is another, by that day. An earlier day's ticked row shows in Done when no
 * card in this copy stands for it: one item per card it names (its latest day), none for a card
 * linked today.
 */
export function boardColumns({ cards, today, todayRows, earlierDays, todayStart, weekStart, moving }: ColumnsInput): BoardColumns {
  const byUid = new Map(cards.map((c) => [c.uid, c]));
  const cardOf = (uid: string | null) => (uid == null ? null : (byUid.get(uid) ?? null));
  const linkedToday = new Set(todayRows.flatMap((p) => (p.cardUid == null ? [] : [p.cardUid])));
  // A row with text always has a uid: the card mints one with the text, and the server fills any missing.
  const rowItem = (row: Priority, date: string, column: ColumnId): BoardItem => ({
    id: `row:${date}:${row.uid!}`,
    title: row.text.trim(),
    column,
    card: cardOf(row.cardUid),
    row,
    date,
    categoryUid: row.categoryUid,
    recurring: isRecurring(row),
    planned: null,
  });
  const cardItem = (card: BoardCard, column: ColumnId, planned: string | null = null): BoardItem => ({
    id: `card:${card.uid}`,
    title: card.title,
    column,
    card,
    row: null,
    date: null,
    categoryUid: card.categoryUid,
    recurring: false,
    planned,
  });
  const isPlanned = (c: BoardCard) => c.listDate != null && c.listDate > today;

  const offToday = cards.filter((c) => !linkedToday.has(c.uid) && !c.held);
  const lane = (l: OpenLane) => offToday.filter((c) => c.lane === l).sort(byPosition);
  const later = lane('later')
    .filter((c) => !isPlanned(c))
    .map((c) => cardItem(c, 'later'));
  const plannedElsewhere = offToday.filter((c) => c.lane !== 'next' && isPlanned(c)).sort((a, b) => a.listDate!.localeCompare(b.listDate!));
  const next = [...lane('next'), ...plannedElsewhere].map((c) => cardItem(c, 'next', isPlanned(c) ? c.listDate : null));

  const progress = todayRows.filter(isOpen).map((r) => rowItem(r, today, 'progress'));
  const doneCards = offToday.filter((c) => c.lane === 'done' && !isPlanned(c) && doneTime(c) >= weekStart).sort((a, b) => doneTime(b) - doneTime(a));
  const doneToday = [
    ...todayRows.filter((p) => hasText(p) && p.done).map((r) => rowItem(r, today, 'done')),
    ...doneCards.filter((c) => doneTime(c) >= todayStart).map((c) => cardItem(c, 'done')),
  ];

  // Earlier this week, newest day first; on a day, its cards (newest first) before its rows.
  const earlier: { day: string; item: BoardItem }[] = doneCards
    .filter((c) => doneTime(c) < todayStart)
    .map((c) => ({ day: todayKey(doneTime(c)), item: cardItem(c, 'done') }));
  const named = new Set<string>();
  for (const d of [...earlierDays].sort((a, b) => b.date.localeCompare(a.date))) {
    for (const r of d.priorities) {
      if (!hasText(r) || !r.done || cardOf(r.cardUid)) continue;
      if (r.cardUid != null) {
        if (linkedToday.has(r.cardUid) || named.has(r.cardUid)) continue;
        named.add(r.cardUid);
      }
      earlier.push({ day: d.date, item: rowItem(r, d.date, 'done') });
    }
  }
  // Stable: a day's cards keep their newest-first order ahead of its rows in position order.
  const doneEarlier = earlier.sort((a, b) => b.day.localeCompare(a.day)).map((e) => e.item);

  const columns: BoardColumns = { later, next, progress, doneToday, doneEarlier };
  return moving?.size ? withMoving(columns, moving) : columns;
}

/** The columns with each moving item taken out of its own and put at the top of Later or Done, or the end of Next or In progress. */
function withMoving(columns: BoardColumns, moving: ReadonlyMap<string, ColumnId>): BoardColumns {
  const moved: BoardItem[] = [];
  const stay = (items: BoardItem[]) =>
    items.filter((item) => {
      const to = moving.get(item.id);
      if (to === undefined || to === item.column) return true;
      moved.push({ ...item, column: to });
      return false;
    });
  const out: BoardColumns = {
    later: stay(columns.later),
    next: stay(columns.next),
    progress: stay(columns.progress),
    doneToday: stay(columns.doneToday),
    doneEarlier: stay(columns.doneEarlier),
  };
  for (const item of moved) {
    if (item.column === 'later') out.later.unshift(item);
    else if (item.column === 'done') out.doneToday.unshift(item);
    else out[item.column].push(item);
  }
  return out;
}

/**
 * What a move does, by the store and queue it writes:
 * - `patch`: a card's lane or place in Later or Next (`editCard`);
 * - `park`: today's open row to Later or Next: the board places its card, then the row leaves the list;
 * - `place`: a new row on today's list for a card or an earlier day's row (open with the nudge, or
 *   ticked), in its category, stamped `addedAt` by the store as it goes out: the board's move
 *   handlers are built in its render and passed to its cards, where the React Compiler's purity
 *   lint refuses `Date.now()`;
 * - `tick`: a row of today's list ticked or unticked;
 * - `doneStays`: nothing sent: a done item stays done, and the board notice offers a new card,
 *   with its title and category;
 * - `refuse`: nothing sent: the board notice says why.
 */
export type Move =
  | { kind: 'patch'; uid: string; patch: Omit<CardPatch, 'today'> }
  | { kind: 'park'; row: Priority; lane: OpenLane; before: string | null }
  | { kind: 'place'; row: Omit<Priority, 'position'>; nudge: boolean }
  | { kind: 'tick'; rowUid: string; done: boolean; cardUid: string | null }
  | { kind: 'doneStays'; title: string; categoryUid: string | null; lane: OpenLane; before: string | null }
  | { kind: 'refuse'; message: string };

/** The moves a store carries out. */
export type StoreMove = Exclude<Move, { kind: 'doneStays' | 'refuse' }>;

export interface MoveContext {
  today: string;
}

const refuse = (message: string): Move => ({ kind: 'refuse', message });

/**
 * What moving `item` to column `to` does, `before` being the card it goes in front of in Later or
 * Next (null: the end). Null when it changes nothing (a drop where it started). A planned item is
 * refused (its day's list decides it); a recurring row stays on today's list; a done item stays
 * done (the notice offers a new card in its place); today's row whose card a later day's list
 * holds can go to Next, where it stays planned, but not to Later.
 */
export function planMove(item: BoardItem, to: ColumnId, before: string | null, ctx: MoveContext): Move | null {
  if (item.planned) return refuse(BOARD.planned(item.title, dayName(item.planned, ctx.today, true)));
  if (to === item.column) {
    // The board keeps an order only in Later and Next, whose items are cards; today's list keeps
    // the sheet's. A row shows in a lane only while its park is on its way, with nothing to sort yet.
    return isLane(to) && item.card && !item.row ? { kind: 'patch', uid: item.card.uid, patch: { before } } : null;
  }
  return isLane(to) ? toLane(item, to, before, ctx) : toToday(item, to === 'done', ctx);
}

function toLane(item: BoardItem, lane: OpenLane, before: string | null, ctx: MoveContext): Move {
  if (item.recurring) return refuse(BOARD.recurringStays(item.title));
  if (item.column === 'done') return { kind: 'doneStays', title: item.title, categoryUid: item.categoryUid, lane, before };
  if (!item.row) return { kind: 'patch', uid: item.card!.uid, patch: { lane, before } };
  // Today's open row. Its card stays planned on the later day's list, which Next shows and Later can't.
  const later = plannedFor(item, ctx.today);
  if (later && lane === 'later') return refuse(BOARD.planned(item.title, dayName(later, ctx.today, true)));
  return { kind: 'park', row: item.row, lane, before };
}

function toToday(item: BoardItem, done: boolean, ctx: MoveContext): Move {
  if (item.row && item.date === ctx.today) return { kind: 'tick', rowUid: item.row.uid!, done, cardUid: item.row.cardUid };
  // A card, or an earlier day's ticked row with no card (whose new row the save makes one for): a
  // row of today's own, in the item's category, which the save would otherwise copy onto the card.
  const row = {
    uid: newUid(),
    addedAt: null,
    text: item.title,
    done,
    cardUid: item.card?.uid ?? null,
    recurringUid: null,
    categoryUid: item.categoryUid,
  };
  return { kind: 'place', row, nudge: !done };
}

/** The columns in the order the board shows them. */
export const COLUMNS: ColumnId[] = ['later', 'next', 'progress', 'done'];

/**
 * The columns Move to offers: every other one, none for a planned item, and no Later or Next for
 * a recurring row. A done item, and today's row planned for a later day, keep Later and Next,
 * which answer with the board notice.
 */
export function moveTargets(item: BoardItem): ColumnId[] {
  if (item.planned) return [];
  return COLUMNS.filter((c) => c !== item.column && !(item.recurring && (c === 'later' || c === 'next')));
}

/** A board move the store turned down before it changed anything; its message is the line to show. */
export class MoveRefused extends Error {}

/** The drop id of a column, which `dropTarget` looks up; an item's drop id is its own id. */
export const columnDropId = (column: ColumnId): string => `col:${column}`;

/** Where a drop lands: the column, and in Later or Next the card it goes before (null: the end). */
export interface DropTarget {
  to: ColumnId;
  before: string | null;
}

/** Later and Next: the lanes, which hold cards and keep their order. */
export function isLane(column: ColumnId): column is OpenLane {
  return column === 'later' || column === 'next';
}

/** A column's items in the order shown: Done is today's, then the rest of the week. */
function itemsIn(columns: BoardColumns, column: ColumnId): BoardItem[] {
  return column === 'done' ? [...columns.doneToday, ...columns.doneEarlier] : columns[column];
}

/** The item with this id and the column showing it, or null when no column does. */
export function findItem(columns: BoardColumns, id: string): { item: BoardItem; column: ColumnId } | null {
  for (const column of COLUMNS) {
    const item = itemsIn(columns, column).find((i) => i.id === id);
    if (item) return { item, column };
  }
  return null;
}

/**
 * The columns as a drag shows them: the item taken out of the column showing it and shown in
 * `to`, before the card named in Later or Next (null: the end), at the end of In progress or the
 * top of Done. It keeps its `column`, the one the drag started in.
 */
export function withDrag(columns: BoardColumns, id: string, { to, before }: DropTarget): BoardColumns {
  const found = findItem(columns, id);
  if (!found) return columns;
  const without = (items: BoardItem[]) => items.filter((i) => i.id !== id);
  const out: BoardColumns = {
    later: without(columns.later),
    next: without(columns.next),
    progress: without(columns.progress),
    doneToday: without(columns.doneToday),
    doneEarlier: without(columns.doneEarlier),
  };
  if (to === 'done') out.doneToday.unshift(found.item);
  else if (to === 'progress') out.progress.push(found.item);
  else {
    const lane = out[to];
    const at = lane.findIndex((i) => cardUidOf(i) === before);
    lane.splice(at === -1 ? lane.length : at, 0, found.item);
  }
  return out;
}

/**
 * Where a drop lands: the column, and in Later or Next the card uid it goes before (null: the
 * end). `over` is `col:<column>` (`columnDropId`) or an item id, looked up in `columns`, which are
 * as the drag shows them (`withDrag`). In a lane that shows the item, it takes the place of the
 * card it is over, as the list showed it sorting: past it going down, before it going up; in a
 * lane that doesn't, it goes before that card, and over the column itself, at the end. Null when
 * it lands nowhere or where it started: in its own column (`item.column`), at its place there.
 */
export function dropTarget(over: string | null, active: string, columns: BoardColumns): DropTarget | null {
  const from = findItem(columns, active);
  if (!from || over == null) return null;
  const to = COLUMNS.find((c) => columnDropId(c) === over) ?? findItem(columns, over)?.column;
  if (!to) return null;
  if (!isLane(to)) return to === from.item.column ? null : { to, before: null };
  const lane = columns[to];
  const shownAt = lane.findIndex((i) => i.id === active);
  const overAt = lane.findIndex((i) => i.id === over);
  // Its index in the lane once it lands: over the column itself it stays where it shows, or goes at the end.
  const at = overAt === -1 ? (shownAt === -1 ? lane.length : shownAt) : overAt;
  const rest = lane.filter((i) => i.id !== active);
  const before = cardUidOf(rest[at]);
  const started = to === from.item.column && shownAt !== -1 && before === cardUidOf(lane[shownAt + 1]);
  return started ? null : { to, before };
}

/** The drag's closing line for the move `planMove` gave: it stayed, it moved, it was refused (the notice's line), or it stays done. */
export function moveAnnouncement(move: Move | null, item: BoardItem, to: ColumnId, names: Record<ColumnId, string>): string {
  if (!move) return BOARD_DRAG.stays(item.title, names[item.column]);
  if (move.kind === 'refuse') return move.message;
  if (move.kind === 'doneStays') return DONE_STAYS.announce(item.title, names[move.lane]);
  return BOARD_DRAG.moved(item.title, names[to]);
}

/** What a drag says as it goes over a column: where the item would land, in Later or Next before which card, or that it is back where it started (a null target). */
export function overAnnouncement(target: DropTarget | null, item: BoardItem, columns: BoardColumns, names: Record<ColumnId, string>): string {
  if (!target) return BOARD_DRAG.overStart(item.title, names[item.column]);
  const name = names[target.to];
  if (!isLane(target.to)) return BOARD_DRAG.over(item.title, name);
  const next = target.before == null ? undefined : columns[target.to].find((i) => cardUidOf(i) === target.before);
  return next ? BOARD_DRAG.overBefore(item.title, name, next.title) : BOARD_DRAG.overEnd(item.title, name);
}

/**
 * The left-open rows the offer brings back while the board is on, as seeds for today's list: a
 * row whose card has left Next (moved to Later, done, or deleted on the board) stays where the
 * board put it, and one whose card is in Next takes the card's title and category. The board may
 * have changed either since that day, and the row's own would be written back onto the card when
 * today's list is saved. A row with no card goes as written. Null while the board hasn't loaded.
 */
export function offeredLeftovers(rows: Priority[], cards: BoardCard[] | undefined): PrioritySeed[] | null {
  if (!cards) return null;
  const byUid = new Map(cards.map((c) => [c.uid, c]));
  return rows.flatMap((p) => {
    const seed = { text: p.text, cardUid: p.cardUid, recurringUid: p.recurringUid, categoryUid: p.categoryUid };
    if (p.cardUid == null) return [seed];
    const card = byUid.get(p.cardUid);
    return card?.lane === 'next' ? [{ ...seed, text: card.title, categoryUid: card.categoryUid }] : [];
  });
}

/**
 * `card` taken out of `cards` and put in `lane` before `before`, or at the end when that names no
 * other card of the lane, out of Done, with the lane numbered from 1 as the server numbers it.
 */
function placed(cards: BoardCard[], card: BoardCard, lane: OpenLane, before: string | null): BoardCard[] {
  const others = cards.filter((c) => c.uid !== card.uid);
  const order = others.filter((c) => c.lane === lane).sort(byPosition);
  const at = order.findIndex((c) => c.uid === before);
  order.splice(at === -1 ? order.length : at, 0, { ...card, lane, doneAt: null });
  const numbered = new Map(order.map((c, i) => [c.uid, { ...c, position: i + 1 }]));
  return [...others.filter((c) => c.lane !== lane), ...numbered.values()];
}

/** The board as `POST /board/cards` leaves it: a new card in its lane, or an existing one placed there with the title and category sent. */
export function withCard(board: Board, card: NewCard, now: number): Board {
  const found = board.cards.find((c) => c.uid === card.uid);
  const made: BoardCard = found
    ? { ...found, title: card.title, categoryUid: card.categoryUid }
    : {
        uid: card.uid,
        title: card.title,
        categoryUid: card.categoryUid,
        lane: card.lane,
        position: 0,
        createdAt: now,
        doneAt: null,
        listDate: null,
        held: false,
      };
  return { ...board, cards: placed(board.cards, made, card.lane, card.before) };
}

/** The board as `PATCH /board/cards/:uid` leaves it: the title, the category, a lane (out of Done too), or `before` alone to reorder an open lane. */
export function withPatch(board: Board, uid: string, { title, categoryUid, lane, before }: Omit<CardPatch, 'today'>): Board {
  const card = board.cards.find((c) => c.uid === uid);
  if (!card) return board;
  const titled = { ...card, title: title ?? card.title, categoryUid: categoryUid === undefined ? card.categoryUid : categoryUid };
  const to = lane ?? (card.lane === 'done' ? undefined : card.lane);
  if (to === undefined || (to === card.lane && before === undefined)) return { ...board, cards: board.cards.map((c) => (c.uid === uid ? titled : c)) };
  return { ...board, cards: placed(board.cards, titled, to, before ?? null) };
}

/** The board without the card. */
export function withoutCard(board: Board, uid: string): Board {
  return { ...board, cards: board.cards.filter((c) => c.uid !== uid) };
}

/**
 * The category chip's data, from `useCategoryPick`: the board's categories and New category's
 * create, for the views that offer the chip.
 */
export interface CategoryPick {
  /** Every category, removed ones included; only those in use are offered. */
  categories: Category[];
  /**
   * The uid to set for a name typed into New category (`categoryForName`), with the category sent
   * on its way when it is new or removed; null for a blank name.
   */
  create: (name: string) => string | null;
  /** Reads the board again: the list calls it as it opens, so a category made on another device is there. */
  refresh: () => void;
}

/** The categories in use, in the order they were made: what the chip and Settings offer. */
export function activeCategories(categories: Category[]): Category[] {
  return categories.filter((c) => !c.archived);
}

/** The category `uid` names, a removed one included; undefined for none, or a uid the board doesn't hold. */
export function categoryOf(categories: Category[], uid: string | null): Category | undefined {
  return uid == null ? undefined : categories.find((c) => c.uid === uid);
}

/**
 * The colour the fewest categories in use have, the first in `CATEGORY_COLORS` on a tie: an
 * unused one while any is left, then the colours repeat evenly, since there are only eight.
 */
export function nextColor(categories: Category[]): CategoryColor {
  const uses = (color: CategoryColor) => categories.filter((c) => !c.archived && c.color === color).length;
  return CATEGORY_COLORS.reduce((best, color) => (uses(color) < uses(best) ? color : best));
}

/** Whether a category in use, other than `exceptUid`, has this name, whatever its case or spacing. */
export function categoryNameTaken(categories: Category[], name: string, exceptUid: string | null): boolean {
  const key = sameText(name);
  return categories.some((c) => !c.archived && c.uid !== exceptUid && sameText(c.name) === key);
}

/**
 * What New category makes of `name`, as the server will take it: the category in use with that
 * name (nothing to send); else a removed one with that name, the newest if several, brought back
 * under its own uid (the server refuses its name to a new uid), in its old colour while no
 * category in use has it, else in `nextColor`; else a new category under `uid` in `nextColor`.
 * Null for a blank name.
 */
export function categoryForName(categories: Category[], name: string, uid: string): { uid: string; send: NewCategory | null } | null {
  const tidy = categoryName(name);
  if (!tidy) return null;
  const named = categories.filter((c) => sameText(c.name) === sameText(tidy));
  const inUse = named.find((c) => !c.archived);
  if (inUse) return { uid: inUse.uid, send: null };
  const removed = named.at(-1);
  if (!removed) return { uid, send: { uid, name: tidy, color: nextColor(categories) } };
  const free = !categories.some((c) => !c.archived && c.color === removed.color);
  return { uid: removed.uid, send: { uid: removed.uid, name: tidy, color: free ? removed.color : nextColor(categories) } };
}

/**
 * The board as `POST /board/categories` leaves it: a new category after the others, a removed one
 * back in use in its place with the name and colour sent, or one in use as it was (a retry).
 */
export function withCategory(board: Board, sent: NewCategory): Board {
  const found = board.categories.find((c) => c.uid === sent.uid);
  if (found && !found.archived) return board;
  const made: Category = { uid: sent.uid, name: sent.name, color: sent.color, archived: false };
  return { ...board, categories: found ? board.categories.map((c) => (c === found ? made : c)) : [...board.categories, made] };
}

/** The board as `PATCH /board/categories/:uid` leaves it: a new name or colour, a field left out kept. */
export function withCategoryPatch(board: Board, uid: string, patch: CategoryPatch): Board {
  return { ...board, categories: board.categories.map((c) => (c.uid === uid ? { ...c, ...patch } : c)) };
}

/** The board as `DELETE /board/categories/:uid` leaves it: the category kept, so past time keeps its name, and out of use. */
export function withoutCategory(board: Board, uid: string): Board {
  return { ...board, categories: board.categories.map((c) => (c.uid === uid ? { ...c, archived: true } : c)) };
}

/** Weekdays as the server answers them: ascending. */
const ascending = (days: number[]) => [...days].sort((a, b) => a - b);

/** The board as `POST /board/recurring` leaves it: the item after the others, or as it was when its uid is held (a retry). */
export function withRecurring(board: Board, item: Recurring): Board {
  if (board.recurring.some((r) => r.uid === item.uid)) return board;
  return { ...board, recurring: [...board.recurring, { ...item, weekdays: ascending(item.weekdays) }] };
}

/** The board as `PATCH /board/recurring/:uid` leaves it: the fields sent, weekdays ascending; a field left out kept. */
export function withRecurringPatch(board: Board, uid: string, patch: RecurringPatch): Board {
  return {
    ...board,
    recurring: board.recurring.map((r) => (r.uid === uid ? { ...r, ...patch, weekdays: ascending(patch.weekdays ?? r.weekdays) } : r)),
  };
}

/** The board without the item. */
export function withoutRecurring(board: Board, uid: string): Board {
  return { ...board, recurring: board.recurring.filter((r) => r.uid !== uid) };
}
