import { DndContext, DragOverlay, useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { addDays, startOfWeek } from '../../../../shared/dates.js';
import { useBoardState, useBoardStore, useCategoryPick } from '../../hooks/useBoard';
import { useCelebration, type Moment } from '../../hooks/useCelebration';
import { useDay } from '../../hooks/useDay';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useRange } from '../../hooks/useRange';
import { useSettings } from '../../hooks/useSettings';
import { useShortcut } from '../../hooks/useShortcuts';
import type { TimerCtx } from '../../hooks/useTimer';
import { unlockAudio } from '../../lib/alerts';
import {
  boardColumns,
  boardFull,
  categoryOf,
  columnDropId,
  COLUMN_NAMES,
  COLUMNS,
  findItem,
  isLane,
  itemPatchOf,
  itemsIn,
  laneStart,
  moveAnnouncement,
  onToday,
  planMove,
  saved,
  type BoardItem,
  type ColumnId,
  type DropTarget,
  type Move,
  type RowPatch,
  type StoreMove,
} from '../../lib/board';
import { ADD_PRIORITY_FAILED, BOARD, CONFIRM, DONE_STAYS, LOAD_FAILED, WARNING_ACTIONS } from '../../lib/copy';
import { dayName, formatDurationCeil } from '../../lib/format';
import { hasRoom, newTaskRow, newUid, nudgeFor, pickWarning, placePriority, type WarningKind } from '../../lib/priorities';
import { loggedByUid } from '../../lib/retro';
import { readStored, USER_KEYS, writeStored } from '../../lib/storage';
import type { OpenLane, Priority } from '../../types';
import { Burst } from '../Burst';
import { Folded } from '../Folded';
import { Plus } from '../Icons';
import { LoadFailed } from '../LoadFailed';
import { BoardCardView, type ItemDrag } from './BoardCard';
import { Capture } from './Capture';
import { CardDialog } from './CardDialog';
import { ClockBar } from './ClockBar';
import { canDrag, canSort, DraggableEntry, Lifted, SortableEntry, useBoardDrag } from './useBoardDrag';

/** The columns with a + in their head. */
type AddColumn = Exclude<ColumnId, 'done'>;

/**
 * How a move was made: where a tick was (its burst starts there), and the length of the timer a
 * dialog's Start starts on the task once its pull lands.
 */
type MoveOptions = { at?: DOMRect; minutes?: number };

/** What a nudge holds until Add anyway: a pull, or a row typed in In progress's box. */
type Held = { item: BoardItem; target: DropTarget; move: StoreMove } | { row: ReturnType<typeof newTaskRow> };

/** What the board notice holds: one at a time, the newest move's. */
type Notice =
  /** A task for a list already as long as the sheet's nudge allows: held until Add anyway. */
  | { kind: 'nudge'; warning: WarningKind; text: string; for: Held }
  /**
   * The move itself, with the item it was about: a done item moved to Later or Next (it stays
   * done, and a new card can take its place), or a move refused before anything was sent.
   */
  | (Extract<Move, { kind: 'doneStays' | 'refuse' }> & { item: BoardItem });

/** A board write sent and let go, its failure a banner. */
function report(write: Promise<void>): void {
  void saved(write);
}

/**
 * The Board page: Later, Next, In progress and Done. In progress is today's list, the sheet's
 * Top priorities, and Done holds this week. A card opens its dialog (`CardDialog`, one at a time).
 * An item moves by being dragged (a mouse, a finger's hold or Space) or by its dialog's Move to,
 * and both go through `planMove`; a move the board can't make shows in the notice above the
 * columns. The + in Later's, Next's and In progress's head opens a box for a new item there.
 * `now` is App's clock floored to the minute, the one the sheet gets, for the clock bar's times
 * and Delete's count of a timer running on the task: the page renders once a minute, and the
 * sheet's tiles and × count to the same minute. The move, add and delete handlers are built in
 * render, where the purity lint refuses Date.now() (the store stamps a typed row's `addedAt`).
 * The timer's `running`, `start` and `starting` come from App too: its context changes every
 * second, and these only when a timer starts, changes or ends.
 */
export const Board = memo(function Board({
  today,
  now,
  running,
  start,
  starting,
}: { today: string; now: number } & Pick<TimerCtx, 'running' | 'start' | 'starting'>) {
  const { board, failed } = useBoardState();
  const store = useBoardStore();
  const { settings } = useSettings();
  const { day, failed: dayFailed, store: dayStore } = useDay(today);
  const weekStart = startOfWeek(today);
  // Done holds the week: the days before today (none on a Monday) give the rows ticked on them; a
  // failed read says so in Done, with Try again.
  const { days: earlierDays, failed: earlierFailed, retry: retryEarlier } = useRange(weekStart, addDays(today, -1), today !== weekStart);
  const pick = useCategoryPick();
  useEffect(() => void store.load(), [store]);

  const [moving, setMoving] = useState<ReadonlyMap<string, DropTarget>>(() => new Map());
  const [notice, setNotice] = useState<Notice | null>(null);
  // The item whose dialog is open.
  const [open, setOpen] = useState<string | null>(null);
  // Notes whose save failed as their dialog closed, by item, with the stored note each was typed
  // over: the dialog's box starts from one, which goes once the item's note is no longer that.
  const [notesKept, setNotesKept] = useState<ReadonlyMap<string, { text: string; over: string }>>(() => new Map());
  // The title the open dialog's box saved last: Safari leaves the focus in the box as a button is
  // pressed, so a move or start pressed there saves the rename only as the dialog closes, after the
  // item was read, and today's row shows it only once its save starts.
  const renamed = useRef<string | null>(null);
  // Below 900 px one column shows at a time, so In progress and Done, whose items drag only to
  // another column, don't drag there.
  const [shownColumn, setShownColumn] = useState<ColumnId>('progress');
  const wide = useMediaQuery('(min-width: 900px)');
  const [earlierOpen, setEarlierOpen] = useState(false);
  const [ticked, setTicked] = useState<Moment | null>(null);
  const { burst } = useCelebration<HTMLElement>(ticked, 'priorityDone');
  const lastWarning = useRef<string | undefined>(undefined);
  // Rows sent to today's list whose board job hasn't landed yet, by where they land: the nudge counts them.
  const queued = useRef(new Map<string, Omit<Priority, 'position'>>());
  const titles = useRef(new Map<string, HTMLButtonElement>());
  const noticeBox = useRef<HTMLDivElement>(null);
  // The columns whose box is open, each box's field, and where the focus goes back to in a column:
  // its +, or Done's heading.
  const [adding, setAdding] = useState<ReadonlySet<AddColumn>>(() => new Set());
  const fields = useRef(new Map<AddColumn, HTMLInputElement>());
  const heads = useRef(new Map<ColumnId, HTMLElement>());
  // The boxes' one category, remembered on this device (a removed or unknown one reads as none).
  const [boxCategory, setBoxCategory] = useState(() => readStored(USER_KEYS.captureCategory) || null);
  // The item a sent move left focus for: its card once it shows under that id, which a keyboard
  // drag's Space picks up again.
  const focusTo = useRef<string | null>(null);

  const columns = useMemo(
    () =>
      board && day
        ? boardColumns({
            cards: board.cards,
            today,
            todayRows: day.priorities,
            earlierDays: earlierDays ?? [],
            recurring: board.recurring,
            moving,
          })
        : null,
    [board, day, earlierDays, today, moving],
  );
  const { shown, over, lifted, dropAnimation, context, onDragEnd, onDragCancel } = useBoardDrag(columns);
  // An item that went (deleted, gone from a read, or a new day loading) closes its dialog for good,
  // so it doesn't open again by itself if the item comes back.
  const opened = open && columns ? findItem(columns, open)?.item : undefined;
  if (open && !opened) setOpen(null);

  useEffect(() => {
    const id = focusTo.current;
    const title = id ? titles.current.get(id) : undefined;
    if (!title) return;
    focusTo.current = null;
    // Only when the move left the focus nowhere (its control went with the dialog or the item): a
    // move that lands late finds the user typing elsewhere, and leaves them there.
    const at = document.activeElement;
    if (at === null || at === document.body) title.focus();
  });
  // A notice brought by a move takes the focus, so a keyboard user reaches its buttons.
  useEffect(() => {
    if (notice) noticeBox.current?.querySelector('button')?.focus();
  }, [notice]);
  // The one way a box opens: its column shows (a phone has one at a time), and its field takes the
  // focus inside the tap, which is what lets iOS raise the keyboard. An open box only takes the focus.
  const openAdd = (id: AddColumn) => {
    flushSync(() => {
      setShownColumn(id);
      setAdding((a) => new Set(a).add(id));
    });
    fields.current.get(id)?.focus();
  };
  // N is Later's +, while that would open the box. A hook, so bound above the returns below.
  const laterKey = useShortcut('new', board && day && pick && !boardFull(board) ? () => openAdd('later') : null);

  if (failed && !board)
    return (
      <div className="board">
        <LoadFailed title={LOAD_FAILED.board} onRetry={() => void store.load()} />
      </div>
    );
  if (dayFailed && !day)
    return (
      <div className="board">
        <LoadFailed title={LOAD_FAILED.title} onRetry={() => void dayStore.load(today)} />
      </div>
    );
  if (!board || !day || !columns || !shown || !pick) return <div className="board loading" aria-busy="true" />;

  const todayRows = day.priorities;

  // The move goes to the store; the item shows in its new column meanwhile. A tick celebrates
  // from where it was made (`at`, measured by the caller before the control goes with the item to
  // Done in this render, hidden there on a phone). The sound is unlocked in the tap that made it
  // (iOS). With no item, a row typed in In progress's box, whose field keeps the focus: nothing is
  // focused for it once it lands. With `minutes`, a pull a dialog's Start made: the timer starts on
  // the task once the pull's save answers, and one banner says why if either fails. Every caller
  // runs with no dialog open: a dialog closes before its move or start (`closeCard`).
  const send = (item: BoardItem | null, target: DropTarget, move: StoreMove, { at, minutes }: MoveOptions = {}) => {
    const ticks = (move.kind === 'tick' && move.done) || (move.kind === 'place' && move.row.done);
    if (ticks) {
      unlockAudio();
      setTicked({ at });
    }
    // Where the item will be once the move lands: a task keeps its id wherever it shows, and an
    // earlier day's recurring row pulled onto today's list lands as today's row, while the earlier
    // one stays in Done.
    const lands = move.kind === 'place' ? `item:${move.row.uid}` : item!.id;
    if (item) focusTo.current = lands;
    setMoving((m) => new Map(m).set(lands, target));
    if (move.kind === 'place') queued.current.set(lands, move.row);
    const sent = store.move(move).finally(() => {
      queued.current.delete(lands);
      setMoving((m) => {
        const next = new Map(m);
        next.delete(lands);
        return next;
      });
    });
    if (minutes == null) report(sent);
    else {
      const pulled = sent.then(() => item!.uid);
      report(start(today, minutes * 60, item!.title, pulled));
    }
    // A move that failed leaves the item where it was, under its old id: nothing to wait for.
    void sent.catch(() => {
      if (focusTo.current === lands) focusTo.current = null;
    });
  };

  // Past the sheet's nudge, as Add priority asks, a task for today's list waits in the notice for
  // Add anyway: the notice's line, or null when it goes at once.
  const askFirst = (held: Held): string | null => {
    // Judged on today's list as the board's queue will leave it, so a row sent but not shown yet
    // counts, as the sheet's draft does; a row already shown isn't placed twice.
    const rows = [...queued.current.values()].reduce((list, row) => placePriority(list, settings.priorityCount, row) ?? list, todayRows);
    const warning = nudgeFor(rows, settings.priorityCount);
    if (!warning) return null;
    const text = pickWarning(warning, lastWarning.current);
    lastWarning.current = text;
    setNotice({ kind: 'nudge', warning, text, for: held });
    return text;
  };

  // Every move, dragged or picked in Move to, goes through here: the newest one takes the notice's
  // place. It answers with what a drag says as it ends.
  const run = (item: BoardItem, to: ColumnId, before: string | null, options: MoveOptions = {}): string => {
    const move = planMove(item, to, before, today);
    setNotice(null);
    if (move?.kind === 'refuse' || move?.kind === 'doneStays') setNotice({ ...move, item });
    else if (move) {
      const target = { to, before };
      // A Start's pull goes at once: starting a timer never asks.
      const asked = move.kind === 'place' && move.nudge && options.minutes == null ? askFirst({ item, target, move }) : null;
      if (asked) return asked;
      send(item, target, move, options);
    }
    return moveAnnouncement(move, item, to);
  };

  // The row In progress's nudge holds goes when its box closes or changes, so Add anyway never adds
  // what the box no longer says: the next Enter asks again.
  const dropHeldRow = () => setNotice((n) => (n?.kind === 'nudge' && 'row' in n.for ? null : n));
  // `back`: the focus goes to the column's +.
  const closeAdd = (id: AddColumn, back: boolean) => {
    setAdding((a) => new Set([...a].filter((c) => c !== id)));
    if (id === 'progress') dropHeldRow();
    if (back) heads.current.get(id)?.focus();
  };
  // A pick in one box is every box's, In progress's included.
  const pickBoxCategory = (uid: string | null) => {
    setBoxCategory(uid);
    writeStored(USER_KEYS.captureCategory, uid ?? '');
    dropHeldRow();
  };
  // A card typed in Later's box goes at the top, one in Next's at the end, as Move to puts them.
  const addCard = (lane: OpenLane) => (title: string, categoryUid: string | null) => {
    report(store.addItem({ uid: newUid(), title, categoryUid, lane, before: laneStart(columns, lane) }));
    return true;
  };
  // A task typed in In progress's box: a new row of today's list through the board's queue, as a
  // pull goes, held in the box past the nudge.
  const placeRow = (row: ReturnType<typeof newTaskRow>) => send(null, { to: 'progress', before: null }, { kind: 'place', row, nudge: true });
  const addRow = (title: string, categoryUid: string | null) => {
    const row = newTaskRow(title, categoryUid, now);
    setNotice(null);
    if (askFirst({ row })) return false;
    placeRow(row);
    return true;
  };

  // Closing the notice puts the focus back where it came from: on the card it was about, or in In
  // progress's box, which keeps the row it held (shown again on a phone, where the notice stays up
  // while another column shows).
  const closeNotice = () => {
    const about = notice?.kind === 'nudge' ? notice.for : notice;
    if (about && 'row' in about) openAdd('progress');
    else if (about) titles.current.get(about.item.id)?.focus();
    setNotice(null);
  };
  // The dialog closes before what it pressed runs, with the focus on its card. Blurring first saves
  // a title or note being typed (React reports no blur for a box removed while focused), as the
  // settings dialog does. It goes at once, since a modal leaves the page inert: the notice's
  // button, the landed card or the next card couldn't take the focus.
  const closeCard = (id: string) => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    flushSync(() => setOpen(null));
    titles.current.get(id)?.focus();
  };

  // The item goes with the button pressed (Delete, Remove from today, Stop repeating on a card of
  // Later's Repeats), and the focus would fall to the page: the next item in its column takes it,
  // else the one before, else the column's + (Done's heading, which has none).
  const focusNear = (item: BoardItem) => {
    const found = findItem(shown, item.id);
    const items = found ? itemsIn(shown, found.column) : [];
    const at = items.findIndex((i) => i.id === item.id);
    const near = [items[at + 1], items[at - 1]].map((i) => i && titles.current.get(i.id)).find((el) => el != null);
    (near ?? (found && heads.current.get(found.column)))?.focus();
  };
  // The full delete, which asks with the days the task is on and the time logged on it: today's
  // row has the counts as the day was last read, its other days' time to which today's log adds
  // (a timer running on it included, as × on the sheet counts it), and any other item the board's.
  const confirmDelete = (item: BoardItem) => {
    const listedToday = onToday(item, today);
    const { listed, logged: counted } = (listedToday ? item.row : item.card)!;
    const todays = listedToday ? (loggedByUid(day.sessions, now).get(item.uid) ?? 0) : 0;
    const logged = counted + todays;
    if (!window.confirm(CONFIRM.deleteTask(listed, logged > 0 ? formatDurationCeil(logged) : null))) return;
    closeCard(item.id);
    focusNear(item);
    report(store.deleteItem(item.uid));
  };
  // The dialog closes, so a remove that fails brings the row back with none open.
  const removeFromToday = (item: BoardItem) => {
    closeCard(item.id);
    focusNear(item);
    report(store.removeFromToday(item.uid));
  };
  // Archived, the recurring priority leaves Later's Repeats; a row of it stays on its day's list.
  const stopRepeating = (item: BoardItem) => {
    if (!window.confirm(CONFIRM.deleteRecurring(item.title))) return;
    closeCard(item.id);
    if (item.row == null) focusNear(item);
    report(store.removeRecurring(item.uid));
  };

  // A drop's move first drops a focus left for an earlier move, and a keyboard drag ends on the item's card.
  const dragFocus = {
    clear: () => {
      focusTo.current = null;
    },
    afterKeyboard: (id: string) => {
      focusTo.current ??= id;
    },
  };

  // Today's row, edited through the list; one shown in a lane is on its way off it (a park), and
  // its row's tick, title and category wait for the park to land.
  const throughRow = (item: BoardItem) => onToday(item, today) && !isLane(item.column);

  const card = (item: BoardItem, drag?: ItemDrag) => (
    <BoardCardView
      key={item.id}
      item={item}
      today={today}
      pick={pick}
      // Later's Repeats lists a recurring priority with its days, and nothing else does: a pull on
      // its way shows the card in In progress or Done with no row yet.
      days={item.column === 'later' ? board.recurring.find((r) => r.uid === item.uid)?.weekdays : undefined}
      onOpen={() => {
        renamed.current = null;
        setOpen(item.id);
      }}
      titleRef={(el) => {
        if (el) titles.current.set(item.id, el);
        else titles.current.delete(item.id);
      }}
      tick={
        throughRow(item)
          ? { checked: item.row!.done, onChange: (checked, el) => run(item, checked ? 'done' : 'progress', null, { at: el.getBoundingClientRect() }) }
          : undefined
      }
      // A recurring task's rows are told apart by their day; a card, which has none, by its task.
      running={running?.priorityUid === item.uid && (item.date ?? running.date) === running.date ? running : undefined}
      drag={drag}
    />
  );

  const cardDialog = (item: BoardItem) => {
    // A task off today's list as the board has it: in a lane, left open, or done on another day.
    const cardOnly = item.card != null && item.row == null;
    // Ticked on another day: that day's sheet unticks it, since the board would rewrite another
    // day's list, and a later day's sheet opens only once that day comes; Move to In progress puts
    // it on today's list to work on again.
    const doneDay = cardOnly && item.card!.listDone ? item.card!.listDate! : null;
    const hint = doneDay == null ? undefined : (doneDay > today ? BOARD.doneAhead : BOARD.doneOn)(dayName(doneDay, today, true));
    // The recurring priority as the board has it, a task given its first day included: none for a
    // one-off, or one that stopped repeating.
    const routine = board.recurring.find((r) => r.uid === item.uid);
    // Off today's list, a PATCH renames or files it on every day: any one-off task the board has,
    // and a recurring priority's card or earlier day's row while it repeats (one archived answers 404).
    const editable = cardOnly || routine != null;
    // The title, category and note are the task's, on every day: today's row through the list, the
    // sheet's write, which renames a recurring priority too; any other by a PATCH.
    const editTask = throughRow(item)
      ? (patch: RowPatch) => store.editRow(item.uid, patch)
      : editable
        ? (patch: RowPatch) => store.editItem(item.uid, itemPatchOf(patch))
        : null;
    // A note whose save failed is kept for the dialog to start from when it opens again, and one
    // that saves drops it.
    const keepNote = (ok: boolean, text: string, over: string) => {
      setNotesKept((m) => {
        if (ok && !m.has(item.id)) return m;
        const next = new Map(m);
        if (ok) next.delete(item.id);
        else next.set(item.id, { text, over });
        return next;
      });
      return ok;
    };
    // What a press in the dialog acts on once it has closed: the item under the title saved last.
    const closeFor = () => {
      closeCard(item.id);
      return renamed.current === null ? item : { ...item, title: renamed.current };
    };
    // A timer starts on today's open row and on a card in Later or Next, which a pull puts on
    // today's list first, with no nudge: starting a timer never asks. None while a timer runs
    // (another device's too, once synced) or the item's move is on its way.
    const startable = !running && !moving.has(item.id) && item.column !== 'done';
    // A one-off's first day makes it a recurring priority, which can't be undone: that asks first.
    // The item stands in for a row whose task the board hasn't read yet.
    const onDay = (day: number, on: boolean) => {
      if (!routine && !window.confirm(CONFIRM.makeRecurring(item.title))) return;
      report(store.editItem(item.uid, { weekday: { day, on } }, item));
    };
    const onStart = (minutes: number) => {
      const acting = closeFor();
      if (!throughRow(acting)) {
        run(acting, 'progress', null, { minutes });
        return;
      }
      // As run() does: the newest press takes the notice's place.
      setNotice(null);
      report(start(today, minutes * 60, acting.title, acting.uid));
    };
    return (
      <CardDialog
        key={item.id}
        item={item}
        today={today}
        pick={pick}
        onClose={() => closeCard(item.id)}
        onMove={(to, el) => {
          // Measured first: the button goes with the dialog.
          const at = el.getBoundingClientRect();
          run(closeFor(), to, isLane(to) ? laneStart(columns, to) : null, { at });
        }}
        onRename={
          editTask
            ? (text) => {
                renamed.current = text;
                report(editTask({ text }));
              }
            : undefined
        }
        onCategory={editTask ? (categoryUid) => report(editTask({ categoryUid })) : undefined}
        onNote={editTask ? (note, base) => saved(editTask({ note })).then((ok) => keepNote(ok, note, base)) : undefined}
        keptNote={notesKept.get(item.id)?.text}
        // A recurring priority has no full delete: it stops repeating, and its row only comes off today's list.
        onDelete={item.recurring ? undefined : () => confirmDelete(item)}
        onRemove={item.recurring && throughRow(item) ? () => removeFromToday(item) : undefined}
        // None on a task the server can't change: a recurring priority that stopped repeating, an archived one-off.
        repeat={
          routine
            ? { days: routine.weekdays, onDay, onStop: () => stopRepeating(item) }
            : !item.recurring && !item.row?.archived
              ? { days: [], onDay }
              : undefined
        }
        hint={hint}
        start={startable ? { disabled: starting, onStart } : undefined}
      />
    );
  };

  // A card of Later or Next sorts among its lane's cards; an item of In progress or Done, and a
  // recurring priority's card in Later's Repeats, drags whole, on a wide window. An item whose move
  // is on its way isn't picked up until the move lands: it shows where the move takes it as the
  // item it was (a parked row in Later, a pulled card in In progress), and a move planned from that
  // would be wrong.
  const entry = (item: BoardItem, column: ColumnId) => {
    const sorts = isLane(column) && canSort(item);
    if (!canDrag(item) || (!sorts && !wide)) return card(item);
    const render = (drag: ItemDrag) => card(item, drag);
    const held = moving.has(item.id);
    return sorts ? (
      <SortableEntry key={item.id} id={item.id} held={held} render={render} />
    ) : (
      <DraggableEntry key={item.id} id={item.id} column={column} held={held} render={render} />
    );
  };
  const list = (items: BoardItem[], column: ColumnId) => <ul className="board-list">{items.map((i) => entry(i, column))}</ul>;
  // A lane lists the cards it shows that sort (Later folds past eight), in order.
  const sorted = (lane: OpenLane, items: BoardItem[], children: ReactNode) => (
    <SortableContext id={lane} items={items.filter(canSort).map((i) => i.id)} strategy={verticalListSortingStrategy}>
      {children}
    </SortableContext>
  );
  const done = shown.doneToday.length + shown.doneEarlier.length;
  const headRef = (id: ColumnId) => (el: HTMLElement | null) => {
    if (el) heads.current.set(id, el);
    else heads.current.delete(id);
  };
  // A column's +, shut with the reason why (`shut`), and its box while open.
  const add = (id: AddColumn, shut: string | null, onAdd: (title: string, categoryUid: string | null) => boolean): ColumnAdd => ({
    shut,
    onOpen: () => openAdd(id),
    keys: id === 'later' ? laterKey : undefined,
    box: adding.has(id) && (
      <Capture
        to={id}
        pick={pick}
        inputRef={(el) => {
          if (el) fields.current.set(id, el);
          else fields.current.delete(id);
        }}
        category={boxCategory}
        onCategory={pickBoxCategory}
        onEdit={id === 'progress' ? dropHeldRow : undefined}
        onAdd={onAdd}
        onClose={(back) => closeAdd(id, back)}
      />
    ),
  });
  // The lanes' cap counts tasks in a lane; a row typed in In progress has none, so only a full list shuts it.
  const lanesFull = boardFull(board) ? BOARD.full : null;
  const listFull = hasRoom(todayRows, settings.priorityCount) ? null : ADD_PRIORITY_FAILED.full;
  // A box closes with its column, so it doesn't open again by itself when the column reopens.
  const shutBoxes = [...adding].filter((id) => (id === 'progress' ? listFull : lanesFull));
  if (shutBoxes.length > 0) {
    setAdding((a) => new Set([...a].filter((id) => !shutBoxes.includes(id))));
    if (shutBoxes.includes('progress')) dropHeldRow();
  }
  // A kept note goes once its item's note isn't the one it was typed over: changed elsewhere, or
  // its save on its way, whose failure keeps it again (an item not shown keeps it).
  const staleNotes = [...notesKept].filter(([id, { over }]) => (findItem(columns, id)?.item.note ?? over) !== over).map(([id]) => id);
  if (staleNotes.length > 0) setNotesKept((m) => new Map([...m].filter(([id]) => !staleNotes.includes(id))));

  return (
    <div className="board">
      {settings.clockBar && <ClockBar day={day} today={today} now={now} />}
      {/* Always there, so what arrives is heard. */}
      <div className="board-notice" role="status" ref={noticeBox}>
        {notice?.kind === 'nudge' && (
          <NoticeView
            onClose={closeNotice}
            actions={[
              {
                label: WARNING_ACTIONS[notice.warning].add,
                run: () => {
                  const held = notice.for;
                  setNotice(null);
                  // The button goes with the notice: the focus goes to the task's card once it lands,
                  // a typed row's box closing.
                  if ('row' in held) {
                    closeAdd('progress', false);
                    setShownColumn('progress');
                    placeRow(held.row);
                    focusTo.current = `item:${held.row.uid}`;
                  } else send(held.item, held.target, held.move);
                },
              },
              { label: WARNING_ACTIONS[notice.warning].keep, run: closeNotice },
            ]}
          >
            {notice.text}
          </NoticeView>
        )}
        {notice?.kind === 'doneStays' && (
          <NoticeView
            onClose={closeNotice}
            actions={[
              {
                label: DONE_STAYS.add(COLUMN_NAMES[notice.lane]),
                run: () => {
                  closeNotice();
                  report(store.addItem({ uid: newUid(), title: notice.title, categoryUid: notice.categoryUid, lane: notice.lane, before: notice.before }));
                },
              },
              { label: DONE_STAYS.leave, run: closeNotice },
            ]}
          >
            <strong>{DONE_STAYS.title(notice.title)}</strong> {DONE_STAYS.body}
          </NoticeView>
        )}
        {notice?.kind === 'refuse' && (
          <NoticeView onClose={closeNotice} actions={[{ label: BOARD.close, run: closeNotice }]}>
            {notice.message}
          </NoticeView>
        )}
      </div>
      {/* One column at a time on a phone: a switch between views, not ARIA tabs (no tab panels or arrow keys). */}
      <div className="segmented board-switch" role="group" aria-label="Board column">
        {COLUMNS.map((id) => (
          <button key={id} className="segment" aria-pressed={shownColumn === id} onClick={() => setShownColumn(id)}>
            {COLUMN_NAMES[id]}
          </button>
        ))}
      </div>
      <DndContext {...context} onDragEnd={(e) => onDragEnd(e, run, dragFocus)} onDragCancel={(e) => onDragCancel(e, dragFocus)}>
        <div className="board-cols">
          <Column
            id="later"
            shown={shownColumn}
            over={over}
            count={shown.later.length + shown.repeats.length}
            headRef={headRef('later')}
            add={add('later', lanesFull, addCard('later'))}
          >
            {shown.later.length > 0 ? (
              <Folded
                className="board-list"
                items={shown.later.map((i) => entry(i, 'later'))}
                count={columns.later.length}
                wrap={(n, ul) => sorted('later', shown.later.slice(0, n), ul)}
              />
            ) : (
              shown.repeats.length === 0 && <Empty>Nothing parked.</Empty>
            )}
            {shown.repeats.length > 0 && (
              <>
                <h3 className="muted small">Repeats</h3>
                {list(shown.repeats, 'later')}
              </>
            )}
          </Column>
          <Column id="next" shown={shownColumn} over={over} count={shown.next.length} headRef={headRef('next')} add={add('next', lanesFull, addCard('next'))}>
            {shown.next.length > 0 ? sorted('next', shown.next, list(shown.next, 'next')) : <Empty>Nothing lined up.</Empty>}
          </Column>
          <Column
            id="progress"
            shown={shownColumn}
            over={over}
            count={shown.progress.length}
            sub="Today's top priorities"
            headRef={headRef('progress')}
            add={add('progress', listFull, addRow)}
          >
            {shown.progress.length > 0 ? list(shown.progress, 'progress') : <Empty>Nothing open on today's list.</Empty>}
          </Column>
          <Column id="done" shown={shownColumn} over={over} count={done} headRef={headRef('done')}>
            {/* Not while the earlier days are unread: a routine ticked then may be all Done has. */}
            {done === 0 && !earlierFailed && <Empty>Nothing done this week.</Empty>}
            {shown.doneToday.length > 0 && list(shown.doneToday, 'done')}
            {shown.doneEarlier.length > 0 && (
              <>
                {/* With nothing above it, the fold's count is the column's. */}
                <button className="btn btn-ghost board-earlier" aria-expanded={earlierOpen} onClick={() => setEarlierOpen((o) => !o)}>
                  Earlier this week{shown.doneToday.length > 0 && ` · ${shown.doneEarlier.length}`}
                </button>
                {earlierOpen && list(shown.doneEarlier, 'done')}
              </>
            )}
            {/* In place of the routines ticked earlier this week. Try again goes as the read starts
                again, so Done's heading takes the focus, as History's ◀ does. */}
            {earlierFailed && (
              <LoadFailed
                title={LOAD_FAILED.range}
                onRetry={() => {
                  heads.current.get('done')?.focus();
                  retryEarlier();
                }}
              />
            )}
          </Column>
        </div>
        {/* On the page's body, so no column clips it; without the glide back when motion is reduced. */}
        {createPortal(
          <DragOverlay dropAnimation={dropAnimation}>
            {lifted && <Lifted item={lifted} category={categoryOf(pick.categories, lifted.categoryUid)} />}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
      <Burst at={burst} />
      {/* Outside the columns, so it stays mounted as its item changes column (a move made
          elsewhere), and a press in it never reaches a card's drag. */}
      {opened && cardDialog(opened)}
    </div>
  );
});

/** A column's + and its box: shut with the line that says why (still reached by Tab), else `onOpen` opens `box`. */
interface ColumnAdd {
  shut: string | null;
  onOpen: () => void;
  /** Its key, for `aria-keyshortcuts`: N on Later's. */
  keys: string | undefined;
  box: ReactNode;
}

/** A column, and where a dragged item lands as a whole (In progress, Done, and an empty lane). */
function Column({
  id,
  shown,
  over,
  count,
  sub,
  headRef,
  add,
  children,
}: {
  id: ColumnId;
  shown: ColumnId;
  over?: ColumnId;
  count: number;
  sub?: string;
  /** Where the focus goes when Delete or Remove from today takes the column's last item: its +, else its heading. */
  headRef: (el: HTMLElement | null) => void;
  add?: ColumnAdd;
  children: ReactNode;
}) {
  const head = `board-col-${id}`;
  const shut = `board-add-${id}`;
  const { setNodeRef } = useDroppable({ id: columnDropId(id) });
  return (
    <section
      ref={setNodeRef}
      className="board-col"
      data-shown={shown === id || undefined}
      // A lane sorts its cards; the dragged item shows in the column it is over.
      data-lane={isLane(id) || undefined}
      data-over={over === id || undefined}
      aria-labelledby={head}
    >
      <header className="board-col-head">
        <h2 id={head} ref={add ? undefined : headRef} tabIndex={add ? undefined : -1}>
          {COLUMN_NAMES[id]}
        </h2>
        <span className="muted">{count}</span>
        {add && (
          <button
            ref={headRef}
            className="btn btn-ghost board-add"
            title={`Add to ${COLUMN_NAMES[id]}`}
            aria-disabled={add.shut ? true : undefined}
            aria-describedby={add.shut ? shut : undefined}
            aria-keyshortcuts={add.keys}
            onClick={add.shut ? undefined : add.onOpen}
          >
            <Plus />
          </button>
        )}
      </header>
      {sub && <p className="muted small board-col-sub">{sub}</p>}
      {add?.shut ? (
        <p className="muted small" id={shut}>
          {add.shut}
        </p>
      ) : (
        add?.box
      )}
      {children}
    </section>
  );
}

/** The board notice's content: its line and buttons, with Escape on a button closing it, and a held Enter or Space pressing none. */
function NoticeView({ actions, onClose, children }: { actions: { label: string; run: () => void }[]; onClose: () => void; children: ReactNode }) {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    // The notice takes the focus from the press that raised it, so a key still held repeats onto
    // its first button: only a fresh press answers.
    else if (e.repeat && (e.key === 'Enter' || e.key === ' ')) e.preventDefault();
  };
  return (
    <div className="notice notice--gentle">
      <span>{children}</span>
      <span className="notice-actions">
        {actions.map((a) => (
          <button key={a.label} className="btn btn-ghost" onClick={a.run} onKeyDown={onKey}>
            {a.label}
          </button>
        ))}
      </span>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="muted small">{children}</p>;
}
