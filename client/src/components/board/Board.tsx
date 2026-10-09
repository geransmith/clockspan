import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragCancelEvent,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { addDays, startOfWeek } from '../../../../shared/dates.js';
import { useBoardState, useBoardStore, useCategoryPick } from '../../hooks/useBoard';
import { useCelebration, type Moment } from '../../hooks/useCelebration';
import { useDay } from '../../hooks/useDay';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useRange } from '../../hooks/useRange';
import { useSettings } from '../../hooks/useSettings';
import { unlockAudio, warnQuietly, warnSaveFailed } from '../../lib/alerts';
import {
  boardColumns,
  boardFull,
  categoryOf,
  columnDropId,
  COLUMNS,
  dropTarget,
  findItem,
  isLane,
  laneStart,
  MoveRefused,
  moveAnnouncement,
  overAnnouncement,
  planMove,
  withDrag,
  type BoardItem,
  type ColumnId,
  type DropTarget,
  type StoreMove,
} from '../../lib/board';
import { BOARD, BOARD_DRAG, CONFIRM, DONE_STAYS, LOAD_FAILED, WARNING_ACTIONS } from '../../lib/copy';
import { dayName, formatDurationCeil } from '../../lib/format';
import { newUid, nudgeFor, pickWarning, type WarningKind } from '../../lib/priorities';
import type { Category, OpenLane } from '../../types';
import { Burst } from '../Burst';
import { CategoryDot } from '../CategoryDot';
import { Folded } from '../Folded';
import { Grip } from '../Icons';
import { LoadFailed } from '../LoadFailed';
import { BoardCardView, COLUMN_NAMES, type ItemDrag } from './BoardCard';
import { Capture } from './Capture';
import { boardCollision, boardKeyboardCoordinates } from './dnd';

/** What the board notice holds: one at a time, the newest move's. */
type Notice =
  /** A pull onto a list already as long as the sheet's nudge allows: held until Add anyway. */
  | { kind: 'nudge'; warning: WarningKind; text: string; item: BoardItem; to: ColumnId; move: StoreMove }
  /** A done item moved to Later or Next: it stays done, and a new card can take its place. */
  | { kind: 'doneStays'; item: BoardItem; title: string; categoryUid: string | null; lane: OpenLane; before: string | null }
  /** A move refused before anything was sent. */
  | { kind: 'refuse'; item: BoardItem; message: string };

/** The dragged item's place in its list while the copy under the pointer moves. */
const DRAGGED_OPACITY = 0.4;

/** A board write's failure as a banner: a refusal's own line, else the save one. */
function report(write: Promise<void>): void {
  void write.catch((err: unknown) => {
    if (err instanceof MoveRefused) warnQuietly({ title: err.message, tag: 'board-move' });
    else warnSaveFailed();
  });
}

/** Planned items (their day's list decides them) and recurring rows (they stay on today's list) have no grip. */
const canDrag = (item: BoardItem) => !item.planned && !item.recurring;

/**
 * The Board page: Later, Next, In progress and Done. In progress is today's list, the sheet's
 * Top priorities, and Done holds this week. An item moves by its grip (a mouse, a finger or the
 * keyboard) or its editor's Move to, and both go through `planMove`; a move the board can't make
 * shows in the notice under the capture box. Memoized: App re-renders every second, and nothing
 * here reads the clock.
 */
export const Board = memo(function Board({ today }: { today: string }) {
  const { board, failed } = useBoardState();
  const store = useBoardStore();
  const { settings } = useSettings();
  const { day, failed: dayFailed, store: dayStore } = useDay(today);
  const weekStart = startOfWeek(today);
  // Done holds the week: the days before today (none on a Monday) give the rows ticked on them.
  const { days: earlierDays } = useRange(weekStart, addDays(today, -1), today !== weekStart);
  const pick = useCategoryPick(report);
  useEffect(() => void store.load(), [store]);

  const [moving, setMoving] = useState<ReadonlyMap<string, ColumnId>>(() => new Map());
  const [notice, setNotice] = useState<Notice | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  // Below 900 px one column shows at a time.
  const [shownColumn, setShownColumn] = useState<ColumnId>('progress');
  const [earlierOpen, setEarlierOpen] = useState(false);
  const [ticked, setTicked] = useState<Moment | null>(null);
  const { burst } = useCelebration<HTMLElement>(ticked, 'priorityDone');
  const lastWarning = useRef<string | undefined>(undefined);
  const titles = useRef(new Map<string, HTMLButtonElement>());
  const noticeBox = useRef<HTMLDivElement>(null);
  // The item a sent move left focus for: its title once it shows under that id, or its grip after
  // a keyboard drag, so Space picks it up again.
  const focusTo = useRef<string | null>(null);
  const focusGrip = useRef(false);

  // The item being dragged and, while it is over another column, where it would land there.
  const [dragged, setDragged] = useState<string | null>(null);
  const [preview, setPreview] = useState<DropTarget | null>(null);
  // What the drag says as it ends: worked out by the drop, which dnd-kit asks for once its handler has run.
  const dropLine = useRef<string | undefined>(undefined);
  // Whether the drag has said what it is over yet: the first time, it is where it was picked up.
  const overSaid = useRef(false);
  // The page's own reduced-motion rule stops the transitions; the drop's glide runs in script.
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const sensors = useSensors(
    // Covers touch too (see SortableCards); the grip's touch-action: none keeps a finger on it from scrolling the page.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: boardKeyboardCoordinates }),
  );

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
  // The columns as the drag shows them.
  const shown = useMemo(() => (columns && dragged && preview ? withDrag(columns, dragged, preview) : columns), [columns, dragged, preview]);

  // The focus on an item: on its grip when asked and it has one that takes the focus (none on a
  // planned card or a recurring row; hidden on a phone in In progress and Done), else its title.
  const focusItem = (title: HTMLButtonElement, toGrip: boolean) => {
    const grip = toGrip ? title.closest('li')?.querySelector<HTMLElement>('.board-grip') : null;
    grip?.focus();
    if (!grip || document.activeElement !== grip) title.focus();
  };
  useEffect(() => {
    const id = focusTo.current;
    const title = id ? titles.current.get(id) : undefined;
    if (!title) return;
    focusTo.current = null;
    const toGrip = focusGrip.current;
    focusGrip.current = false;
    // Only when the move left the focus nowhere (its control went with the editor or the item): a
    // move that lands late finds the user typing elsewhere, and leaves them there.
    const at = document.activeElement;
    if (at === null || at === document.body) focusItem(title, toGrip);
  });
  // A notice brought by a move takes the focus, so a keyboard user reaches its buttons.
  useEffect(() => {
    if (notice) noticeBox.current?.querySelector('button')?.focus();
  }, [notice]);

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
  if (!board || !day || !columns || !shown) return <div className="board sheet-loading" aria-busy="true" />;

  const todayRows = day.priorities;

  // The move goes to the store; the item shows in its new column meanwhile. A tick celebrates
  // from where it was made (`at`, measured by the caller before the control goes with the item to
  // Done in this render, hidden there on a phone). The sound is unlocked in the tap that made it (iOS).
  const send = (item: BoardItem, to: ColumnId, move: StoreMove, at?: DOMRect) => {
    const ticks = (move.kind === 'tick' && move.done) || (move.kind === 'place' && move.row.done);
    if (ticks) {
      unlockAudio();
      setTicked({ at });
    }
    setOpen(null);
    // Where the item will be once the move lands: a one-off task keeps its id wherever it shows, and
    // an earlier day's recurring row pulled onto today's list is today's row.
    const lands = move.kind === 'place' && move.row.recurring ? `row:${today}:${move.row.uid}` : item.id;
    focusTo.current = lands;
    setMoving((m) => new Map(m).set(item.id, to));
    const sent = store.move(move).finally(() =>
      setMoving((m) => {
        const next = new Map(m);
        next.delete(item.id);
        return next;
      }),
    );
    report(sent);
    // A move that failed leaves the item where it was, under its old id: nothing to wait for.
    void sent.catch(() => {
      if (focusTo.current === lands) focusTo.current = null;
    });
  };

  // Every move, dragged or picked in Move to, goes through here: the newest one takes the notice's
  // place. It answers with what a drag says as it ends.
  const run = (item: BoardItem, to: ColumnId, before: string | null, at?: DOMRect): string => {
    const move = planMove(item, to, before, { today });
    setNotice(null);
    focusGrip.current = false;
    if (move?.kind === 'refuse') setNotice({ kind: 'refuse', item, message: move.message });
    else if (move?.kind === 'doneStays')
      setNotice({ kind: 'doneStays', item, title: move.title, categoryUid: move.categoryUid, lane: move.lane, before: move.before });
    else if (move) {
      const warning = move.kind === 'place' && move.nudge ? nudgeFor(todayRows, settings.priorityCount) : null;
      if (!warning) send(item, to, move, at);
      else {
        const text = pickWarning(warning, lastWarning.current);
        lastWarning.current = text;
        setNotice({ kind: 'nudge', warning, text, item, to, move });
        return text;
      }
    }
    return moveAnnouncement(move, item, to, COLUMN_NAMES);
  };

  // Closing the notice puts the focus back on the item it was about, on its grip where it has one.
  const closeNotice = () => {
    const title = notice && titles.current.get(notice.item.id);
    if (title) focusItem(title, true);
    setNotice(null);
  };

  // The full delete, which asks with the days the task is on and the time logged on it: today's
  // row has the counts as the day was last read, any other item the board's.
  const confirmDelete = (item: BoardItem) => {
    const { listed, logged } = (item.date === today ? item.row : item.card)!;
    if (!window.confirm(CONFIRM.deleteTask(listed, logged > 0 ? formatDurationCeil(logged) : null))) return;
    setOpen(null);
    report(store.deleteItem(item.uid));
  };

  const find = (id: UniqueIdentifier) => findItem(shown, String(id));
  const onDragStart = ({ active }: DragStartEvent) => {
    setDragged(String(active.id));
    setPreview(null);
    dropLine.current = undefined;
    overSaid.current = false;
  };
  // Over another column the item shows there, where it would land; back over its own column, where
  // it started. Its place among the cards of the column it shows in is the sortable list's to show.
  const onDragOver = ({ active, over }: DragOverEvent) => {
    const found = find(active.id);
    if (!found || !over) return;
    const target = dropTarget(String(over.id), found.item.id, shown);
    const to = target?.to ?? found.item.column;
    if (to !== found.column) setPreview(target && to !== found.item.column ? target : null);
  };
  // dnd-kit's own focus return is off (it would take the focus from the notice a drop brings), so
  // a keyboard drag gets it back here: on the item's grip, where the move sends the item or where
  // it stays.
  const endDrag = (item: BoardItem | undefined, activatorEvent: Event | null) => {
    setDragged(null);
    setPreview(null);
    if (!item || !(activatorEvent instanceof globalThis.KeyboardEvent)) return;
    focusTo.current ??= item.id;
    focusGrip.current = true;
  };
  const onDragEnd = ({ active, over, activatorEvent }: DragEndEvent) => {
    const item = find(active.id)?.item;
    focusTo.current = null;
    if (item) {
      // The tick's burst starts where the card was let go.
      const r = active.rect.current.translated;
      const at = r ? new DOMRect(r.left, r.top, r.width, r.height) : undefined;
      const target = dropTarget(over ? String(over.id) : null, item.id, shown);
      dropLine.current = target ? run(item, target.to, target.before, at) : moveAnnouncement(null, item, item.column, COLUMN_NAMES);
    }
    endDrag(item, activatorEvent);
  };
  const onDragCancel = ({ active, activatorEvent }: DragCancelEvent) => {
    focusTo.current = null;
    endDrag(find(active.id)?.item, activatorEvent);
  };
  // What a screen reader hears: dnd-kit's own lines read the raw ids.
  const announcements: Announcements = {
    onDragStart: ({ active }) => {
      const item = find(active.id)?.item;
      return item && BOARD_DRAG.pickedUp(item.title, COLUMN_NAMES[item.column]);
    },
    // Back where it started, it says so, but not the first time: "Picked up" has said where it is.
    onDragOver: ({ active, over }) => {
      const item = find(active.id)?.item;
      const first = !overSaid.current;
      overSaid.current = true;
      if (!item || !over) return undefined;
      const target = dropTarget(String(over.id), item.id, shown);
      return target || !first ? overAnnouncement(target, item, shown, COLUMN_NAMES) : undefined;
    },
    onDragEnd: () => dropLine.current,
    onDragCancel: ({ active }) => {
      const item = find(active.id)?.item;
      return item && BOARD_DRAG.cancelled(item.title, COLUMN_NAMES[item.column]);
    },
  };

  const card = (item: BoardItem, drag?: ItemDrag) => {
    const onToday = item.row != null && item.date === today;
    // A task off today's list as the board has it: in a lane, left open, planned, or done earlier.
    const cardOnly = item.card != null && item.row == null;
    // Ticked on an earlier day: that day's sheet unticks it, since the board would rewrite a past
    // day; Move to In progress puts it on today's list to work on again.
    const note = cardOnly && !item.planned && item.card!.listDone ? BOARD.doneOn(dayName(item.card!.listDate!, today, true)) : undefined;
    const tick: Parameters<typeof BoardCardView>[0]['tick'] = onToday
      ? { checked: item.row!.done, onChange: (checked, el) => run(item, checked ? 'done' : 'progress', null, el.getBoundingClientRect()) }
      : undefined;
    // Off today's list, a PATCH renames or files it on every day: any one-off task the board has,
    // and an earlier day's recurring row while its recurring priority is in Settings (one removed
    // there answers 404).
    const editable = cardOnly || (item.recurring && board.recurring.some((r) => r.uid === item.uid));
    return (
      <BoardCardView
        key={item.id}
        item={item}
        today={today}
        open={open === item.id}
        onToggle={() => setOpen((o) => (o === item.id ? null : item.id))}
        onClose={() => {
          titles.current.get(item.id)?.focus();
          setOpen(null);
        }}
        titleRef={(el) => {
          if (el) titles.current.set(item.id, el);
          else titles.current.delete(item.id);
        }}
        tick={tick}
        onMove={(to, el) => run(item, to, to === 'later' || to === 'next' ? laneStart(columns, to) : null, el.getBoundingClientRect())}
        // Today's row through the list, the sheet's write, which renames a recurring priority too; any other by a PATCH.
        onRename={onToday ? (text) => report(store.editRow(item.uid, { text })) : editable ? (title) => report(store.editItem(item.uid, { title })) : undefined}
        category={pick ? categoryOf(pick.categories, item.categoryUid) : undefined}
        pick={pick}
        // As the title: the category is the task's, on every day.
        onCategory={
          onToday
            ? (categoryUid) => report(store.editRow(item.uid, { categoryUid }))
            : editable
              ? (categoryUid) => report(store.editItem(item.uid, { categoryUid }))
              : undefined
        }
        // A recurring priority is removed in Settings → Board, so its row only comes off today's list.
        onDelete={item.recurring ? undefined : () => confirmDelete(item)}
        onRemove={item.recurring && onToday ? () => report(store.removeFromToday(item.uid)) : undefined}
        note={note}
        drag={drag}
      />
    );
  };

  // A card of Later or Next sorts among its lane's cards; an item of In progress or Done drags whole.
  // An item whose move is on its way keeps its grip but isn't picked up until the move lands: it
  // shows where the move takes it as the item it was (a parked row in Later, a pulled card in In
  // progress), and a move planned from that would be wrong.
  const entry = (item: BoardItem, column: ColumnId) => {
    if (!canDrag(item)) return card(item);
    const render = (drag: ItemDrag) => card(item, drag);
    const held = moving.has(item.id);
    return isLane(column) ? (
      <SortableEntry key={item.id} id={item.id} held={held} render={render} />
    ) : (
      <DraggableEntry key={item.id} id={item.id} column={column} held={held} render={render} />
    );
  };
  const list = (items: BoardItem[], column: ColumnId) => <ul className="board-list">{items.map((i) => entry(i, column))}</ul>;
  // A lane lists the cards it shows that drag (Later folds past eight), in order.
  const sorted = (lane: OpenLane, items: BoardItem[], children: ReactNode) => (
    <SortableContext id={lane} items={items.filter(canDrag).map((i) => i.id)} strategy={verticalListSortingStrategy}>
      {children}
    </SortableContext>
  );
  const done = shown.doneToday.length + shown.doneEarlier.length;
  const lifted = dragged ? find(dragged)?.item : undefined;

  return (
    <div className="board">
      <Capture
        full={boardFull(board)}
        pick={pick}
        onAdd={(title, lane, categoryUid) => report(store.addItem({ uid: newUid(), title, categoryUid, lane, before: laneStart(columns, lane) }))}
      />
      {/* Always there, so what arrives is heard (see styles.css for its gap). */}
      <div className="board-notice" role="status" ref={noticeBox}>
        {notice?.kind === 'nudge' && (
          <NoticeView
            onClose={closeNotice}
            actions={[
              {
                label: WARNING_ACTIONS[notice.warning].add,
                run: (el) => {
                  setNotice(null);
                  send(notice.item, notice.to, notice.move, el.getBoundingClientRect());
                  // The button goes with the notice: the focus goes to the item's grip once it lands.
                  focusGrip.current = true;
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
      <DndContext
        sensors={sensors}
        collisionDetection={boardCollision}
        accessibility={{ announcements, restoreFocus: false }}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
        <div className="board-cols">
          <Column id="later" shown={shownColumn} over={preview?.to} count={shown.later.length}>
            {shown.later.length > 0 ? (
              <Folded
                className="board-list"
                items={shown.later.map((i) => entry(i, 'later'))}
                count={columns.later.length}
                wrap={(n, ul) => sorted('later', shown.later.slice(0, n), ul)}
              />
            ) : (
              <Empty>Nothing parked.</Empty>
            )}
          </Column>
          <Column id="next" shown={shownColumn} over={preview?.to} count={shown.next.length}>
            {shown.next.length > 0 ? sorted('next', shown.next, list(shown.next, 'next')) : <Empty>Nothing lined up.</Empty>}
          </Column>
          <Column id="progress" shown={shownColumn} over={preview?.to} count={shown.progress.length} sub="Today's top priorities">
            {shown.progress.length > 0 ? list(shown.progress, 'progress') : <Empty>Nothing open on today's list.</Empty>}
          </Column>
          <Column id="done" shown={shownColumn} over={preview?.to} count={done}>
            {done === 0 && <Empty>Nothing done this week.</Empty>}
            {shown.doneToday.length > 0 && list(shown.doneToday, 'done')}
            {shown.doneEarlier.length > 0 && (
              <>
                <button className="btn btn-ghost board-earlier" aria-expanded={earlierOpen} onClick={() => setEarlierOpen((o) => !o)}>
                  Earlier this week · {shown.doneEarlier.length}
                </button>
                {earlierOpen && list(shown.doneEarlier, 'done')}
              </>
            )}
          </Column>
        </div>
        {/* On the page's body, so no column clips it; without the glide back when motion is reduced. */}
        {createPortal(
          <DragOverlay dropAnimation={reduceMotion ? null : undefined}>
            {lifted && <Lifted item={lifted} category={pick ? categoryOf(pick.categories, lifted.categoryUid) : undefined} />}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
      <Burst at={burst} />
    </div>
  );
});

/** A column, and where a dragged item lands as a whole (In progress, Done, and an empty lane). */
function Column({
  id,
  shown,
  over,
  count,
  sub,
  children,
}: {
  id: ColumnId;
  shown: ColumnId;
  over?: ColumnId;
  count: number;
  sub?: string;
  children: ReactNode;
}) {
  const head = `board-col-${id}`;
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
        <h2 id={head}>{COLUMN_NAMES[id]}</h2>
        <span className="muted">{count}</span>
      </header>
      {sub && <p className="muted small board-col-sub">{sub}</p>}
      {children}
    </section>
  );
}

/** A card of Later or Next: the others in its lane make room as it is dragged among them. `held`: not picked up meanwhile (`entry`). */
function SortableEntry({ id, held, render }: { id: string; held: boolean; render: (drag: ItemDrag) => ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: { draggable: held, droppable: false } });
  return render({
    nodeRef: setNodeRef,
    style: { transform: CSS.Translate.toString(transform), transition, opacity: isDragging ? DRAGGED_OPACITY : undefined },
    handleProps: { ...attributes, ...listeners },
  });
}

/** A row or card of In progress or Done, which neither sorts: `column` tells the keyboard where it shows (`boardKeyboardCoordinates`); `held` as above. */
function DraggableEntry({ id, column, held, render }: { id: string; column: ColumnId; held: boolean; render: (drag: ItemDrag) => ReactNode }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id, data: { column }, disabled: held });
  return render({ nodeRef: setNodeRef, style: { opacity: isDragging ? DRAGGED_OPACITY : undefined }, handleProps: { ...attributes, ...listeners } });
}

/** The card under the pointer as it is dragged: its title and category, with the grip it was picked up by. */
function Lifted({ item, category }: { item: BoardItem; category?: Category }) {
  return (
    <div className={`board-card board-card--lifted${item.column === 'done' ? ' is-done' : ''}`}>
      <div className="board-card-row">
        <span className="board-grip" aria-hidden="true">
          <Grip />
        </span>
        <span className="board-card-title">{item.title}</span>
      </div>
      {category && (
        <p className="board-card-meta muted small">
          <span className="board-card-category">
            <CategoryDot color={category.color} />
            {category.name}
          </span>
        </p>
      )}
    </div>
  );
}

/** The board notice's content: its line and buttons, with Escape on a button closing it. */
function NoticeView({
  actions,
  onClose,
  children,
}: {
  actions: { label: string; run: (el: HTMLButtonElement) => void }[];
  onClose: () => void;
  children: ReactNode;
}) {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  };
  return (
    <div className="notice notice--gentle">
      <span>{children}</span>
      <span className="notice-actions">
        {actions.map((a) => (
          <button key={a.label} className="btn btn-ghost" onClick={(e) => a.run(e.currentTarget)} onKeyDown={onKey}>
            {a.label}
          </button>
        ))}
      </span>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="muted small board-empty">{children}</p>;
}
