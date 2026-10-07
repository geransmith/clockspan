import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { addDays, parseDateKey, startOfWeek } from '../../../../shared/dates.js';
import { useBoardState, useBoardStore } from '../../hooks/useBoard';
import { useCelebration, type Moment } from '../../hooks/useCelebration';
import { useDay } from '../../hooks/useDay';
import { useRange } from '../../hooks/useRange';
import { useSettings } from '../../hooks/useSettings';
import { unlockAudio, warnQuietly } from '../../lib/alerts';
import {
  boardColumns,
  boardFull,
  cardUidOf,
  laneStart,
  MoveRefused,
  planMove,
  plannedFor,
  type BoardItem,
  type ColumnId,
  type StoreMove,
} from '../../lib/board';
import { BOARD, CONFIRM, DONE_STAYS, LOAD_FAILED, SAVE_FAILED, WARNING_ACTIONS } from '../../lib/copy';
import { dayName } from '../../lib/format';
import { newUid, nudgeFor, pickWarning, type WarningKind } from '../../lib/priorities';
import type { OpenLane } from '../../types';
import { Burst } from '../Burst';
import { Folded } from '../Folded';
import { LoadFailed } from '../LoadFailed';
import { BoardCardView, COLUMN_NAMES } from './BoardCard';
import { Capture } from './Capture';

const COLUMN_IDS: ColumnId[] = ['later', 'next', 'progress', 'done'];

/** What the board notice holds: one at a time, the newest move's. */
type Notice =
  /** A pull onto a list already as long as the sheet's nudge allows: held until Add anyway. */
  | { kind: 'nudge'; warning: WarningKind; text: string; item: BoardItem; to: ColumnId; move: StoreMove }
  /** A done item moved to Later or Next: it stays done, and a new card can take its place. */
  | { kind: 'doneStays'; item: BoardItem; title: string; categoryUid: string | null; lane: OpenLane; before: string | null }
  /** A move refused before anything was sent. */
  | { kind: 'refuse'; item: BoardItem; message: string };

/** A board write's failure as a banner: a refusal's own line, else the save one. */
function report(write: Promise<void>): void {
  void write.catch((err: unknown) =>
    warnQuietly(err instanceof MoveRefused ? { title: err.message, tag: 'board-move' } : { ...SAVE_FAILED, tag: 'save-failed' }),
  );
}

/**
 * The Board page: Later, Next, In progress and Done. In progress is today's list, the sheet's
 * Top priorities, and Done holds this week. Each item moves through its editor's Move to; a move
 * the board can't make shows in the notice under the capture box. Memoized: App re-renders every
 * second, and nothing here reads the clock.
 */
export const Board = memo(function Board({ today }: { today: string }) {
  const { board, failed } = useBoardState();
  const store = useBoardStore();
  const { settings } = useSettings();
  const { day, failed: dayFailed, store: dayStore } = useDay(today);
  const weekStart = startOfWeek(today);
  // Done holds the week: the days before today (none on a Monday) give the rows ticked on them.
  const { days: earlierDays } = useRange(weekStart, addDays(today, -1), today !== weekStart);
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
  // The item a sent move left focus for: its title once it shows under that id.
  const focusTo = useRef<string | null>(null);

  const columns = useMemo(
    () =>
      board && day
        ? boardColumns({
            cards: board.cards,
            today,
            todayRows: day.priorities,
            earlierDays: earlierDays ?? [],
            todayStart: parseDateKey(today).getTime(),
            weekStart: parseDateKey(weekStart).getTime(),
            moving,
          })
        : null,
    [board, day, earlierDays, today, weekStart, moving],
  );

  useEffect(() => {
    const id = focusTo.current;
    const title = id ? titles.current.get(id) : undefined;
    if (!title) return;
    focusTo.current = null;
    // Only when the move left the focus nowhere (its control went with the editor or the item): a
    // move that lands late finds the user typing elsewhere, and leaves them there.
    const at = document.activeElement;
    if (at === null || at === document.body) title.focus();
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
  if (!board || !day || !columns) return <div className="board sheet-loading" aria-busy="true" />;

  const todayRows = day.priorities;

  // The move goes to the store; the item shows in its new column meanwhile. A tick celebrates
  // from where it was made, measured now: the control goes with the item to Done in this render
  // (hidden there on a phone). The sound is unlocked in the tap that made it (iOS).
  const send = (item: BoardItem, to: ColumnId, move: StoreMove, from?: HTMLElement) => {
    const ticks = (move.kind === 'tick' && move.done) || (move.kind === 'place' && move.row.done);
    if (ticks) {
      unlockAudio();
      setTicked({ at: from?.getBoundingClientRect() });
    }
    setOpen(null);
    // Where the item will be once the move lands: a pulled card is a row of today's, a parked row its card.
    const lands = move.kind === 'place' ? `row:${today}:${move.row.uid}` : move.kind === 'park' ? move.row.cardUid && `card:${move.row.cardUid}` : item.id;
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

  // Every Move to goes through here: the newest one takes the notice's place.
  const run = (item: BoardItem, to: ColumnId, before: string | null, from?: HTMLElement) => {
    const move = planMove(item, to, before, { today });
    setNotice(null);
    if (!move) return;
    if (move.kind === 'refuse') return setNotice({ kind: 'refuse', item, message: move.message });
    if (move.kind === 'doneStays')
      return setNotice({ kind: 'doneStays', item, title: move.title, categoryUid: move.categoryUid, lane: move.lane, before: move.before });
    const warning = move.kind === 'place' && move.nudge ? nudgeFor(todayRows, settings.priorityCount) : null;
    if (warning) {
      const text = pickWarning(warning, lastWarning.current);
      lastWarning.current = text;
      return setNotice({ kind: 'nudge', warning, text, item, to, move });
    }
    send(item, to, move, from);
  };

  // Closing the notice puts the focus back on the item it was about.
  const closeNotice = () => {
    if (notice) titles.current.get(notice.item.id)?.focus();
    setNotice(null);
  };

  const remove = (item: BoardItem) => {
    const onToday = item.row != null && item.date === today;
    const later = plannedFor(item, today);
    const off = [...(onToday ? [dayName(today, today, true)] : []), ...(later ? [dayName(later, today, true)] : [])];
    if (!window.confirm(CONFIRM.deleteCard(off))) return;
    setOpen(null);
    report(store.deleteCard(cardUidOf(item), onToday ? item.row!.uid : null, later));
  };

  const card = (item: BoardItem) => {
    const onToday = item.row != null && item.date === today;
    const cardOnly = item.card != null && item.row == null;
    let tick: Parameters<typeof BoardCardView>[0]['tick'];
    if (onToday) tick = { checked: item.row!.done, onChange: (checked, el) => run(item, checked ? 'done' : 'progress', null, el) };
    // A Done card off today's list: unticking is the correction for a mistaken tick, back to Next.
    else if (cardOnly && item.column === 'done') tick = { checked: true, onChange: () => report(store.editCard(item.card!.uid, { lane: 'next' })) };
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
        onMove={(to, el) => run(item, to, to === 'later' || to === 'next' ? laneStart(columns, to) : null, el)}
        onRename={
          onToday
            ? (text) => report(store.renameRow(item.row!.uid!, text, item.row!.cardUid))
            : cardOnly
              ? (title) => report(store.editCard(item.card!.uid, { title }))
              : undefined
        }
        // Not on a Done card off today's list: Done is the week's record, and deleting the card would
        // only bring back its ticked row from an earlier day. The untick is the correction.
        onDelete={!item.recurring && (onToday || (cardOnly && item.column !== 'done')) ? () => remove(item) : undefined}
        onRemove={item.recurring && onToday ? () => report(store.deleteCard(null, item.row!.uid, null)) : undefined}
      />
    );
  };

  const list = (items: BoardItem[]) => <ul className="board-list">{items.map(card)}</ul>;
  const done = columns.doneToday.length + columns.doneEarlier.length;

  return (
    <div className="board">
      <Capture
        full={boardFull(board)}
        onAdd={(title, lane) => report(store.addCard({ uid: newUid(), title, categoryUid: null, lane, before: laneStart(columns, lane) }))}
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
                  send(notice.item, notice.to, notice.move, el);
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
                  report(store.addCard({ uid: newUid(), title: notice.title, categoryUid: notice.categoryUid, lane: notice.lane, before: notice.before }));
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
        {COLUMN_IDS.map((id) => (
          <button key={id} className="segment" aria-pressed={shownColumn === id} onClick={() => setShownColumn(id)}>
            {COLUMN_NAMES[id]}
          </button>
        ))}
      </div>
      <div className="board-cols">
        <Column id="later" shown={shownColumn} count={columns.later.length}>
          {columns.later.length > 0 ? <Folded className="board-list" items={columns.later.map(card)} /> : <Empty>Nothing parked.</Empty>}
        </Column>
        <Column id="next" shown={shownColumn} count={columns.next.length}>
          {columns.next.length > 0 ? list(columns.next) : <Empty>Nothing lined up.</Empty>}
        </Column>
        <Column id="progress" shown={shownColumn} count={columns.progress.length} sub="Today's top priorities">
          {columns.progress.length > 0 ? list(columns.progress) : <Empty>Nothing open on today's list.</Empty>}
        </Column>
        <Column id="done" shown={shownColumn} count={done}>
          {done === 0 && <Empty>Nothing done this week.</Empty>}
          {columns.doneToday.length > 0 && list(columns.doneToday)}
          {columns.doneEarlier.length > 0 && (
            <>
              <button className="btn btn-ghost board-earlier" aria-expanded={earlierOpen} onClick={() => setEarlierOpen((o) => !o)}>
                Earlier this week · {columns.doneEarlier.length}
              </button>
              {earlierOpen && list(columns.doneEarlier)}
            </>
          )}
        </Column>
      </div>
      <Burst at={burst} />
    </div>
  );
});

function Column({ id, shown, count, sub, children }: { id: ColumnId; shown: ColumnId; count: number; sub?: string; children: ReactNode }) {
  const head = `board-col-${id}`;
  return (
    <section className="board-col" data-shown={shown === id || undefined} aria-labelledby={head}>
      <header className="board-col-head">
        <h2 id={head}>{COLUMN_NAMES[id]}</h2>
        <span className="muted">{count}</span>
      </header>
      {sub && <p className="muted small board-col-sub">{sub}</p>}
      {children}
    </section>
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
