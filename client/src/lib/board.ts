/**
 * The board's logic, with no React and no dnd-kit: which column each task and each of today's
 * rows shows in (`boardColumns`), what a move does and which store it writes (`planMove`), where a
 * drop lands and what a drag says (`dropTarget`, `withDrag`, `moveAnnouncement`), the leftovers
 * the left-open offer brings back (`offeredLeftovers`), what New category makes of a name
 * (`categoryForName`, `nextColor`), and the board as a write shows it before the server answers
 * (`withItem`, `withItemPatch`, `withoutItem`, `withCategory`, `withCategoryPatch`,
 * `withoutCategory`).
 *
 * Each task is stored once, and nothing about In progress or Done is: a task on today's list
 * shows as its row there, and any other one-off task by its latest entry (`listDate`, `listDone`)
 * and its lane (`boardColumns`), so the board and the sheet show one list and can't disagree.
 */
import type { CategoryPatch, ItemPatch, NewCategory, NewItem } from '../api';
import { BOARD_LIMITS, CATEGORY_COLORS, LOOKBACK_DAYS } from '../../../shared/api.js';
import { addDays, startOfWeek } from '../../../shared/dates.js';
import { hasText } from '../../../shared/priorities.js';
import { categoryName, sameText } from '../../../shared/text.js';
import type { Board, BoardCard, Category, CategoryColor, Day, OpenLane, Priority, Recurring } from '../types';
import { BOARD, BOARD_DRAG, DONE_STAYS } from './copy';
import { dayName } from './format';
import type { PrioritySeed } from './plan';

/** The board's four columns. Later and Next are lanes a task is put in; In progress and Done are worked out from the days. */
export type ColumnId = 'later' | 'next' | 'progress' | 'done';

export interface BoardItem {
  /**
   * The React key, and what a move and the focus follow: `item:<uid>` for a one-off task, which
   * shows once on the board, and `row:<date>:<uid>` for a recurring priority's row, which Done
   * shows once a day. Looked up, never parsed.
   */
  id: string;
  /** The task's uid. */
  uid: string;
  title: string;
  column: ColumnId;
  /** The task as this copy of the board has it; null for a recurring row, or a row of today's whose task the board hasn't read yet. */
  card: BoardCard | null;
  /** The task's row on its day's list: today's, or an earlier day's for a recurring priority ticked then; null off the lists. */
  row: Priority | null;
  /** The row's day; null with no row. */
  date: string | null;
  /** What a pulled row or a done item's new task takes. */
  categoryUid: string | null;
  recurring: boolean;
  /** For a task off today's list that a later day's list holds (its `listDate`): shown in Next, and moved only by that day's list. */
  planned: string | null;
  /** For a task in no lane whose latest entry, on an earlier day of the last `LOOKBACK_DAYS`, was left open: that day. Shown in Next. */
  leftOpen: string | null;
}

export interface BoardColumns {
  later: BoardItem[];
  /** Next's own tasks, then the tasks left open, then the other planned ones. */
  next: BoardItem[];
  progress: BoardItem[];
  /** Today's ticked rows, then the tasks whose latest entry, today's, was ticked. */
  doneToday: BoardItem[];
  /** Done earlier this week: newest day first. */
  doneEarlier: BoardItem[];
}

/** The later day whose list holds the item's task, or null when none after `today` does. */
export function plannedFor(item: BoardItem, today: string): string | null {
  const day = item.card?.listDate;
  return day != null && day > today ? day : null;
}

/** Tasks in Later and Next that aren't done, which the server caps at `BOARD_LIMITS.openCards`. */
export function boardFull(board: Board): boolean {
  return board.cards.filter((c) => c.lane != null && !c.listDone).length >= BOARD_LIMITS.openCards;
}

/** Whether giving the task a lane adds one to what `boardFull` counts: one in no lane, or done, or one this copy doesn't have. */
export function addsToLanes(board: Board, uid: string): boolean {
  const card = board.cards.find((c) => c.uid === uid);
  return !card || card.lane == null || card.listDone;
}

/** The item's uid when it is one of `lane`'s own tasks, which a place in the lane is given before; null for any other. */
function laneUid(item: BoardItem | undefined, lane: OpenLane): string | null {
  return item?.card?.lane === lane ? item.uid : null;
}

/** Where capture and Move to put a task: the top of Later, the end of Next's own tasks. */
export function laneStart(columns: BoardColumns, lane: OpenLane): string | null {
  return lane === 'later' ? (columns.later.find((i) => laneUid(i, 'later') != null)?.uid ?? null) : null;
}

const byPosition = (a: BoardCard, b: BoardCard) => a.position - b.position;

/** A row with a task on it and its name written: what the board shows of a day's list. */
const isTaskRow = (p: Priority): p is Priority & { uid: string } => p.uid != null && hasText(p);

export interface ColumnsInput {
  /** The board's one-off tasks. */
  cards: BoardCard[];
  today: string;
  /** Today's list as the day store shows it. */
  todayRows: Priority[];
  /** This week's days before today, for the recurring priorities ticked on them. */
  earlierDays: Day[];
  /** The recurring priorities in Settings, whose title and category an earlier day's row of one shows, as a rename shows at once. */
  recurring: Recurring[];
  /** Items shown in another column while a move that spans two stores is on its way, by item id. */
  moving?: ReadonlyMap<string, ColumnId>;
}

/**
 * What each column shows. A task on today's list shows as its row: open in In progress, ticked in
 * Done. Any other one-off task, by the first that applies: a later day's list holds it (planned,
 * in Next: in its place when its lane is Next, else after the tasks left open, by day); its latest
 * entry is ticked (Done, when that day is this week, else nowhere); its lane; with no lane, its
 * latest entry was left open on an earlier day of the last `LOOKBACK_DAYS` (in Next after its own
 * tasks, newest day first, then oldest made first); else nowhere. Done also holds each recurring
 * priority ticked on an earlier day this week, once a day.
 */
export function boardColumns({ cards, today, todayRows, earlierDays, recurring, moving }: ColumnsInput): BoardColumns {
  const weekStart = startOfWeek(today);
  const oldest = addDays(today, -LOOKBACK_DAYS);
  const byUid = new Map(cards.map((c) => [c.uid, c]));
  const written = todayRows.filter(isTaskRow);
  const listedToday = new Set(written.map((p) => p.uid));
  const routines = new Map(recurring.map((r) => [r.uid, r]));
  const rowItem = (row: Priority & { uid: string }, date: string, column: ColumnId): BoardItem => ({
    id: row.recurring ? `row:${date}:${row.uid}` : `item:${row.uid}`,
    uid: row.uid,
    title: row.text.trim(),
    column,
    card: byUid.get(row.uid) ?? null,
    row,
    date,
    categoryUid: row.categoryUid,
    recurring: row.recurring,
    planned: null,
    leftOpen: null,
  });
  const cardItem = (card: BoardCard, column: ColumnId, at: Partial<Pick<BoardItem, 'planned' | 'leftOpen'>> = {}): BoardItem => ({
    id: `item:${card.uid}`,
    uid: card.uid,
    title: card.title,
    column,
    card,
    row: null,
    date: null,
    categoryUid: card.categoryUid,
    recurring: false,
    planned: null,
    leftOpen: null,
    ...at,
  });

  const later: BoardCard[] = [];
  const ownNext: BoardCard[] = [];
  const leftOpen: BoardCard[] = [];
  const plannedElsewhere: BoardCard[] = [];
  const doneOffToday: BoardCard[] = [];
  const earlier: { day: string; item: BoardItem }[] = [];
  for (const c of cards) {
    if (listedToday.has(c.uid)) continue;
    const day = c.listDate;
    if (day != null && day > today) (c.lane === 'next' ? ownNext : plannedElsewhere).push(c);
    else if (c.listDone) {
      if (day === today) doneOffToday.push(c);
      else if (day! >= weekStart) earlier.push({ day: day!, item: cardItem(c, 'done') });
    } else if (c.lane === 'later') later.push(c);
    else if (c.lane === 'next') ownNext.push(c);
    else if (day != null && day < today && day >= oldest) leftOpen.push(c);
  }
  // Newest day first, then the one made first; the server keeps no order for them.
  leftOpen.sort((a, b) => b.listDate!.localeCompare(a.listDate!) || a.createdAt - b.createdAt);
  plannedElsewhere.sort((a, b) => a.listDate!.localeCompare(b.listDate!));
  const planned = (c: BoardCard) => (c.listDate != null && c.listDate > today ? c.listDate : null);
  const next = [
    ...ownNext.sort(byPosition).map((c) => cardItem(c, 'next', { planned: planned(c) })),
    ...leftOpen.map((c) => cardItem(c, 'next', { leftOpen: c.listDate })),
    ...plannedElsewhere.map((c) => cardItem(c, 'next', { planned: c.listDate })),
  ];

  const progress = written.filter((p) => !p.done).map((p) => rowItem(p, today, 'progress'));
  const doneToday = [...written.filter((p) => p.done).map((p) => rowItem(p, today, 'done')), ...doneOffToday.map((c) => cardItem(c, 'done'))];
  for (const d of earlierDays) {
    for (const p of d.priorities.filter(isTaskRow)) {
      if (!p.recurring || !p.done) continue;
      const item = rowItem(p, d.date, 'done');
      const r = routines.get(p.uid);
      earlier.push({ day: d.date, item: r ? { ...item, title: r.title, categoryUid: r.categoryUid } : item });
    }
  }
  // Stable: on a day, the tasks keep the server's order ahead of the routines' rows in position order.
  const doneEarlier = earlier.sort((a, b) => b.day.localeCompare(a.day)).map((e) => e.item);

  const columns: BoardColumns = { later: later.sort(byPosition).map((c) => cardItem(c, 'later')), next, progress, doneToday, doneEarlier };
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
 * - `patch`: a task's lane or place in Later or Next (`editItem`);
 * - `park`: today's open row to Later or Next: the board places its task, then the row leaves the list;
 * - `place`: the task on today's list (open with the nudge, or ticked), in its category, stamped
 *   `addedAt` by the store as it goes out: the board's move handlers are built in its render and
 *   passed to its cards, where the React Compiler's purity lint refuses `Date.now()`;
 * - `tick`: a row of today's list ticked or unticked;
 * - `doneStays`: nothing sent: a done item stays done, and the board notice offers a new task,
 *   with its title and category;
 * - `refuse`: nothing sent: the board notice says why.
 */
export type Move =
  | { kind: 'patch'; uid: string; patch: ItemPatch }
  | { kind: 'park'; uid: string; lane: OpenLane; before: string | null }
  | { kind: 'place'; row: Omit<Priority, 'position'>; nudge: boolean }
  | { kind: 'tick'; uid: string; done: boolean }
  | { kind: 'doneStays'; title: string; categoryUid: string | null; lane: OpenLane; before: string | null }
  | { kind: 'refuse'; message: string };

/** The moves a store carries out. */
export type StoreMove = Exclude<Move, { kind: 'doneStays' | 'refuse' }>;

export interface MoveContext {
  today: string;
}

const refuse = (message: string): Move => ({ kind: 'refuse', message });

/**
 * What moving `item` to column `to` does, `before` being the task it goes in front of in Later or
 * Next (null: the end of the lane's own tasks). Null when it changes nothing (a drop where it
 * started). A planned item is refused (its day's list decides it); a recurring row stays on
 * today's list; a done item stays done (the notice offers a new task in its place); today's row
 * whose task a later day's list holds can go to Next, where it stays planned, but not to Later. A
 * task left open gets a place of its own in Next, or in Later.
 */
export function planMove(item: BoardItem, to: ColumnId, before: string | null, ctx: MoveContext): Move | null {
  if (item.planned) return refuse(BOARD.planned(item.title, dayName(item.planned, ctx.today, true)));
  if (to === item.column) {
    // The board keeps an order only in Later and Next; today's list keeps the sheet's. A row shows
    // in a lane only while its park is on its way, with nothing to sort yet.
    if (!isLane(to) || onToday(item, ctx)) return null;
    return { kind: 'patch', uid: item.uid, patch: item.leftOpen ? { lane: to, before } : { before } };
  }
  return isLane(to) ? toLane(item, to, before, ctx) : toToday(item, to === 'done', ctx);
}

const onToday = (item: BoardItem, ctx: MoveContext) => item.row != null && item.date === ctx.today;

function toLane(item: BoardItem, lane: OpenLane, before: string | null, ctx: MoveContext): Move {
  if (item.recurring) return refuse(BOARD.recurringStays(item.title));
  if (item.column === 'done') return { kind: 'doneStays', title: item.title, categoryUid: item.categoryUid, lane, before };
  if (!onToday(item, ctx)) return { kind: 'patch', uid: item.uid, patch: { lane, before } };
  // Today's open row. Its task stays planned on the later day's list, which Next shows and Later can't.
  const later = plannedFor(item, ctx.today);
  if (later && lane === 'later') return refuse(BOARD.planned(item.title, dayName(later, ctx.today, true)));
  return { kind: 'park', uid: item.uid, lane, before };
}

function toToday(item: BoardItem, done: boolean, ctx: MoveContext): Move {
  if (onToday(item, ctx)) return { kind: 'tick', uid: item.uid, done };
  // The task itself, put on today's list in its category, a recurring priority's included. Until
  // the save answers, its row shows the counts the earlier row or the board had: an item off
  // today's list is one or the other.
  const from = (item.row ?? item.card)!;
  const row: Omit<Priority, 'position'> = {
    uid: item.uid,
    text: item.title,
    done,
    addedAt: null,
    categoryUid: item.categoryUid,
    recurring: item.recurring,
    archived: false,
    listed: from.listed,
    earlier: 0,
    logged: from.logged,
  };
  return { kind: 'place', row, nudge: !done };
}

/** The columns in the order the board shows them. */
export const COLUMNS: ColumnId[] = ['later', 'next', 'progress', 'done'];

/**
 * The columns Move to offers: every other one, none for a planned item, and no Later or Next for
 * a recurring row. A done item, and today's row planned for a later day, keep Later and Next,
 * which answer with the board notice. A task left open keeps Next too, which gives it a place.
 */
export function moveTargets(item: BoardItem): ColumnId[] {
  if (item.planned) return [];
  return COLUMNS.filter((c) => (c !== item.column || (c === 'next' && item.leftOpen != null)) && !(item.recurring && isLane(c)));
}

/** A board move the store turned down before it changed anything; its message is the line to show. */
export class MoveRefused extends Error {}

/** The drop id of a column, which `dropTarget` looks up; an item's drop id is its own id. */
export const columnDropId = (column: ColumnId): string => `col:${column}`;

/** Where a drop lands: the column, and in Later or Next the task it goes before (null: the end of the lane's own tasks). */
export interface DropTarget {
  to: ColumnId;
  before: string | null;
}

/** Later and Next: the lanes a task is put in, which keep their order. */
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
 * `to`, before the task named in Later or Next (null: after the lane's own tasks), at the end of
 * In progress or the top of Done. It keeps its `column`, the one the drag started in.
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
    const at = lane.findIndex((i) => (before == null ? laneUid(i, to) == null : laneUid(i, to) === before));
    lane.splice(at === -1 ? lane.length : at, 0, found.item);
  }
  return out;
}

/**
 * Where a drop lands: the column, and in Later or Next the uid of the task it goes before (null:
 * the end of the lane's own tasks, which is also where it goes in front of a task left open or
 * one planned with no place in the lane). `over` is `col:<column>` (`columnDropId`) or an item
 * id, looked up in `columns`, which are as the drag shows them (`withDrag`). In a lane that shows
 * the item, it takes the place of the item it is over, as the list showed it sorting: past it
 * going down, before it going up; in a lane that doesn't, it goes before that item, and over the
 * column itself, at the end. Null when it lands nowhere or where it started: in its own column
 * (`item.column`), at its place there, or for one of the lane's own tasks, before the same task.
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
  const before = laneUid(rest[at], to);
  const own = laneUid(from.item, to) != null;
  const started = to === from.item.column && shownAt !== -1 && (own ? before === laneUid(lane[shownAt + 1], to) : at === shownAt);
  return started ? null : { to, before };
}

/** The drag's closing line for the move `planMove` gave: it stayed, it moved, it was refused (the notice's line), or it stays done. */
export function moveAnnouncement(move: Move | null, item: BoardItem, to: ColumnId, names: Record<ColumnId, string>): string {
  if (!move) return BOARD_DRAG.stays(item.title, names[item.column]);
  if (move.kind === 'refuse') return move.message;
  if (move.kind === 'doneStays') return DONE_STAYS.announce(item.title, names[move.lane]);
  return BOARD_DRAG.moved(item.title, names[to]);
}

/** What a drag says as it goes over a column: where the item would land, in Later or Next before which task, or that it is back where it started (a null target). */
export function overAnnouncement(target: DropTarget | null, item: BoardItem, columns: BoardColumns, names: Record<ColumnId, string>): string {
  if (!target) return BOARD_DRAG.overStart(item.title, names[item.column]);
  const name = names[target.to];
  if (!isLane(target.to)) return BOARD_DRAG.over(item.title, name);
  const next = target.before == null ? undefined : columns[target.to].find((i) => i.uid === target.before);
  return next ? BOARD_DRAG.overBefore(item.title, name, next.title) : BOARD_DRAG.overEnd(item.title, name);
}

/**
 * The left-open rows the offer brings back while the board is on: each row's own task, under its
 * current name, unless this copy of the board has the task in Later or done (its latest entry
 * ticked), where the board put it. A task the copy doesn't have (a read behind) is offered. An
 * archived one-off (a deleted card that `server/migrations/oneItem.ts` kept for its rows) is never
 * offered. Null while the board hasn't loaded.
 */
export function offeredLeftovers(rows: Priority[], cards: BoardCard[] | undefined): PrioritySeed[] | null {
  if (!cards) return null;
  const byUid = new Map(cards.map((c) => [c.uid, c]));
  return rows.filter((p) => {
    const card = byUid.get(p.uid!);
    return !p.archived && card?.lane !== 'later' && !card?.listDone;
  });
}

/**
 * `card` taken out of `cards` and put in `lane` before `before`, or at the end when that names no
 * other task of the lane, with the lane numbered from 1 as the server numbers it.
 */
function placed(cards: BoardCard[], card: BoardCard, lane: OpenLane, before: string | null): BoardCard[] {
  const others = cards.filter((c) => c.uid !== card.uid);
  const order = others.filter((c) => c.lane === lane).sort(byPosition);
  const at = order.findIndex((c) => c.uid === before);
  order.splice(at === -1 ? order.length : at, 0, { ...card, lane });
  const numbered = new Map(order.map((c, i) => [c.uid, { ...c, position: i + 1 }]));
  return [...others.filter((c) => c.lane !== lane), ...numbered.values()];
}

/** Weekdays as the server answers them: ascending. */
const ascending = (days: number[]) => [...days].sort((a, b) => a - b);

/**
 * The board as `POST /items` leaves it: a new task in its lane, or a new recurring priority after
 * the others, its weekdays ascending; as it was when the uid is held already (a retry).
 */
export function withItem(board: Board, item: NewItem, now: number): Board {
  if (board.cards.some((c) => c.uid === item.uid) || board.recurring.some((r) => r.uid === item.uid)) return board;
  const { uid, title, categoryUid } = item;
  if ('weekdays' in item) return { ...board, recurring: [...board.recurring, { uid, title, categoryUid, weekdays: ascending(item.weekdays) }] };
  const made: BoardCard = { uid, title, categoryUid, lane: item.lane, position: 0, createdAt: now, listDate: null, listDone: false, listed: 0, logged: 0 };
  return { ...board, cards: placed(board.cards, made, item.lane, item.before) };
}

/**
 * The board as `PATCH /items/:uid` leaves it: the fields sent, a field left out kept. A task takes
 * a lane, or `before` alone to reorder its lane; a recurring priority takes weekdays, ascending.
 */
export function withItemPatch(board: Board, uid: string, { title, categoryUid, lane, before, weekdays }: ItemPatch): Board {
  const named = <T extends { title: string; categoryUid: string | null }>(t: T): T => ({
    ...t,
    title: title ?? t.title,
    categoryUid: categoryUid === undefined ? t.categoryUid : categoryUid,
  });
  if (board.recurring.some((r) => r.uid === uid)) {
    return { ...board, recurring: board.recurring.map((r) => (r.uid === uid ? { ...named(r), weekdays: ascending(weekdays ?? r.weekdays) } : r)) };
  }
  const card = board.cards.find((c) => c.uid === uid);
  if (!card) return board;
  const to = lane ?? card.lane;
  if (to == null || (to === card.lane && before === undefined)) return { ...board, cards: board.cards.map((c) => (c === card ? named(c) : c)) };
  return { ...board, cards: placed(board.cards, named(card), to, before ?? null) };
}

/** The board without the task: deleted, or a recurring priority removed. */
export function withoutItem(board: Board, uid: string): Board {
  return { ...board, cards: board.cards.filter((c) => c.uid !== uid), recurring: board.recurring.filter((r) => r.uid !== uid) };
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
