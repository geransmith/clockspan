import { lazy, memo, Suspense, useEffect, useId, useState } from 'react';
import { useBoardState, useBoardStore, useCategoryPick } from '../hooks/useBoard';
import { useDay } from '../hooks/useDay';
import { useLeftOpen } from '../hooks/useLeftOpen';
import { useRange } from '../hooks/useRange';
import { useRecurringAnswered } from '../hooks/useRecurringAnswered';
import { useSettings } from '../hooks/useSettings';
import { useTimeFormat } from '../hooks/useTimeFormat';
import { warnSaveFailed } from '../lib/alerts';
import { LOAD_FAILED, PUNCH_ORDER } from '../lib/copy';
import { startOfWeek } from '../../../shared/dates.js';
import { dayName } from '../lib/format';
import { offeredLeftovers } from '../lib/board';
import { CARD_TITLES, moveCard, setCardSide, setCardVisible, SPLIT_QUERY, splitColumns } from '../lib/layout';
import { isOneOff, patchRow } from '../lib/priorities';
import { dueRecurring } from '../lib/recurring';
import { CARD_SIDES } from '../../../shared/settings.js';
import { focusOf } from '../lib/retro';
import { clampToDay, dayTimeclock, punchLabel, type TimeclockResult, type TimeclockState } from '../lib/timeclock';
import { weekHours } from '../lib/week';
import type { CardId, CardSide, Punch } from '../types';
import { CardFrame, type SheetCard } from './CardFrame';
import { FocusTimer } from './FocusTimer';
import { LoadFailed } from './LoadFailed';
import { Priorities } from './Priorities';
import { Retro } from './Retro';
import { SessionLog } from './SessionLog';
import { Timeclock } from './Timeclock';

const SortableCards = lazy(() => import('./SortableCards').then((m) => ({ default: m.SortableCards })));

const OTHER_SIDE: Record<CardSide, CardSide> = { left: 'right', right: 'left' };

interface Props {
  date: string;
  today: string;
  /** The clock floored to the minute: nothing the sheet shows is finer, and the day log keeps its own clock. */
  now: number;
  customize: boolean;
  /** A card to scroll into view once the sheet has rendered (a banner's "Open …" button). */
  jumpTo: CardId | null;
  onJumped: () => void;
  /** See `Timeclock.onEditingChange`. */
  onPunchEditing: (editing: boolean) => void;
}

/** Memoized: App re-renders every second, and the sheet renders once a minute on the minute it is handed. */
export const Sheet = memo(function Sheet({ date, today, now, customize, jumpTo, onJumped, onPunchEditing }: Props) {
  const { settings, update } = useSettings();
  const { day, failed, store } = useDay(date);
  const isToday = date === today;
  const tc = day ? dayTimeclock(day, settings, today, now) : null;
  // The week so far, up to this sheet's day, for the timeclock's week line.
  const { days: weekDays } = useRange(startOfWeek(date), date);
  const week = weekDays ? weekHours(weekDays, settings, today, now) : null;
  const focus = focusOf(day?.sessions ?? []);
  const orderNotice = useId();
  // Today's list with no one-off written yet (a routine on it is no plan) offers what the last
  // planned day left unticked, in the morning notice. With the board on, a task the board holds in
  // Later or as done stays there, and the rest come back beside the recurring priorities due today
  // (those the server has confirmed); until the board has loaded, nothing is offered.
  const { leftOpen, dismiss: dismissLeftOpen } = useLeftOpen(today, isToday && day != null && !day.priorities.some(isOneOff));
  const { answered, answer: answerRecurring } = useRecurringAnswered(today);
  const { board, confirmedRecurring, on: boardOn } = useBoardState();
  const boardStore = useBoardStore();
  // The category chip on the cards that offer one; null while the board is off or not read yet, and then no chip shows.
  const pick = useCategoryPick();
  const leftovers = leftOpen && (boardOn ? offeredLeftovers(leftOpen.rows, board?.cards) : leftOpen.rows);

  const layout = settings.layout;
  const visible = layout.filter((l) => l.visible);
  const hidden = layout.filter((l) => !l.visible);

  // Drag and drop loads with the first Customize, and the sheet stays on it after that:
  // swapping lists remounts every card, which drops what is typed but not saved (a timer
  // label, an open planner), so that happens once at most.
  const [sortable, setSortable] = useState(customize);
  if (customize && !sortable) setSortable(true);

  // Two columns in a wide window, chosen when the sheet mounts and kept until it mounts again
  // (another view, a reload): following the window would remount every card on a resize, which
  // drops what is typed but not saved, as above. A window narrowed since stacks the columns,
  // left over right.
  const [wide] = useState(() => matchMedia(SPLIT_QUERY).matches);
  const columns = wide ? splitColumns(layout) : null;

  // A failed save drops the change, so the stored layout shows again under any later change;
  // the banner is the only sign it happened.
  const saveLayout = (next: typeof layout) => update({ layout: next }).catch(warnSaveFailed);
  const reorder = (from: number, to: number, side?: CardSide) => {
    const next = moveCard(layout, from, to, side);
    if (next) void saveLayout(next);
  };
  // Hide, Show and a move to the other column each unmount the button pressed (the card goes,
  // the chip goes, the card mounts again in its new column), so the focus goes to the button
  // that undoes it: the card's Show chip, its Hide button, its arrow in the new place. A new
  // object each press runs the effect again for the same card.
  const [refocus, setRefocus] = useState<{ selector: string } | null>(null);
  const setVisible = (id: CardId, v: boolean) => {
    setRefocus({ selector: v ? `#card-${id} .card-tools [aria-label^="Hide"]` : `.hidden-strip [data-card="${id}"]` });
    void saveLayout(setCardVisible(layout, id, v));
  };
  const setSide = (id: CardId, side: CardSide) => {
    setRefocus({ selector: `#card-${id} [data-swap]` });
    void saveLayout(setCardSide(layout, id, side));
  };
  useEffect(() => {
    if (refocus) document.querySelector<HTMLElement>(refocus.selector)?.focus();
  }, [refocus]);

  const ready = day != null;
  useEffect(() => {
    if (!jumpTo || !ready) return;
    const card = document.getElementById(`card-${jumpTo}`);
    card?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
    // The banner's button went with the banner; the note box (the one card jumped to is the
    // retrospective) takes the focus, so the next Tab starts there and not at the top of the page.
    card?.querySelector<HTMLElement>('textarea')?.focus({ preventScroll: true });
    onJumped();
  }, [jumpTo, ready, onJumped]);

  // The split class goes on while a day loads too, so the page keeps its width when ◀ or ▶ opens
  // a day the store doesn't hold yet.
  const sheetClass = columns ? 'sheet sheet--split' : 'sheet';
  if (!day || !tc)
    return (
      <div className={sheetClass}>
        {failed ? <LoadFailed title={LOAD_FAILED.title} onRetry={() => void store.load(date)} /> : <div className="loading" aria-busy="true" />}
      </div>
    );

  const render = (id: CardId) => {
    switch (id) {
      case 'timeclock':
        return (
          <Timeclock
            key={date}
            date={date}
            isToday={isToday}
            now={clampToDay(date, today, now)}
            punches={day.punches}
            tc={tc}
            overtimeApproved={day.overtimeApproved}
            workMinutes={day.workMinutes}
            week={week}
            focus={focus}
            onChange={(p) => void store.setPunches(date, p)}
            onOvertimeChange={(v) => void store.setOvertimeApproved(date, v)}
            onWorkMinutesChange={(m) => void store.setWorkMinutes(date, m)}
            onEditingChange={onPunchEditing}
            orderNotice={orderNotice}
          />
        );
      case 'priorities':
        return (
          <Priorities
            key={date}
            priorities={day.priorities}
            sessions={day.sessions}
            now={now}
            pick={pick}
            onChange={(p, base) => store.setPriorities(date, p, base)}
            onDeleteTask={(uid) => boardStore.deleteItem(uid)}
            // The note's own save, on the list as the store shows it; a row gone meanwhile has nothing to save.
            onNote={async (uid, note) => (await store.editPriorities(date, (rows) => patchRow(rows, uid, { note }))) !== 'failed'}
            offer={
              isToday
                ? {
                    leftovers: leftOpen && leftovers?.length ? { from: dayName(leftOpen.date, today, true), rows: leftovers } : null,
                    recurring: boardOn && confirmedRecurring ? dueRecurring(confirmedRecurring, today, day.priorities, answered) : [],
                    answer: (shownRecurring, leftoversShown) => {
                      answerRecurring(shownRecurring);
                      if (leftoversShown) dismissLeftOpen();
                    },
                  }
                : null
            }
          />
        );
      case 'timer':
        return <FocusTimer date={date} isToday={isToday} priorities={day.priorities} pick={pick} />;
      case 'log':
        return <SessionLog date={date} isToday={isToday} sessions={day.sessions} breaks={day.breaks} priorities={day.priorities} pick={pick} />;
      case 'retro':
        return (
          <Retro
            key={date}
            date={date}
            today={today}
            priorities={day.priorities}
            sessions={day.sessions}
            note={day.retroNote}
            reviewedAt={day.retroAt}
            pick={pick}
            onChange={(patch) => store.setRetro(date, patch)}
          />
        );
    }
  };

  // One stack of cards: the whole sheet, or one column of it (`side`), which ↑/↓ and drag and
  // drop stay inside. In a sheet mounted wide each card offers the other column, also while
  // every visible card sits in one (one list), so a card can always be moved back.
  const stack = (entries: typeof layout, side?: CardSide) => {
    const cards: SheetCard[] = entries.map((l, i) => ({
      id: l.id,
      body: render(l.id),
      // Out of order, the state is only 'working' to keep the alarms armed; the notice says why.
      aside: l.id === 'timeclock' && !tc.outOfOrder ? <StatePill state={tc.state} isToday={isToday} /> : undefined,
      customize: customize
        ? {
            onHide: () => setVisible(l.id, false),
            onMove: (dir) => reorder(i, i + dir, side),
            canUp: i > 0,
            canDown: i < entries.length - 1,
            swap: wide ? { to: OTHER_SIDE[l.side], onSwap: () => setSide(l.id, OTHER_SIDE[l.side]) } : undefined,
          }
        : undefined,
    }));
    const plain = cards.map((c) => <CardFrame key={c.id} card={c} />);
    return sortable ? (
      <Suspense fallback={plain}>
        <SortableCards cards={cards} onReorder={(from, to) => reorder(from, to, side)} />
      </Suspense>
    ) : (
      plain
    );
  };

  return (
    <div className={sheetClass}>
      {/* A live region already on the page when the notice appears, or a screen reader may not read it. */}
      <div className="punch-order" role="status">
        {tc.outOfOrder && <PunchOrder id={orderNotice} punches={day.punches} slip={tc.outOfOrder} />}
      </div>
      {columns
        ? CARD_SIDES.map((side) => (
            <div key={side} className="sheet-col">
              {stack(columns[side], side)}
            </div>
          ))
        : stack(visible)}
      {customize && hidden.length > 0 && (
        <div className="hidden-strip">
          <span className="muted">Hidden:</span>
          {hidden.map((l) => (
            <button key={l.id} className="chip" data-card={l.id} onClick={() => setVisible(l.id, true)}>
              {CARD_TITLES[l.id]} <span className="chip-action">Show</span>
            </button>
          ))}
        </div>
      )}
      {visible.length === 0 && !customize && <p className="muted center">All cards are hidden. Use Customize to show them.</p>}
    </div>
  );
});

/** The punch out of place and the one it should come after, named and timed as the card shows them. */
function PunchOrder({ id, punches, slip }: { id: string; punches: Punch[]; slip: NonNullable<TimeclockResult['outOfOrder']> }) {
  const { formatTime } = useTimeFormat();
  const time = (position: number) => {
    const at = punches.find((p) => p.position === position)?.at;
    return at == null ? null : formatTime(at);
  };
  return (
    <div id={id} className="notice notice--danger">
      {PUNCH_ORDER(punchLabel(punches, slip.position), time(slip.position)!, punchLabel(punches, slip.after), time(slip.after))}
    </div>
  );
}

function StatePill({ state, isToday }: { state: TimeclockState; isToday: boolean }) {
  // A past day is judged at its end, so one still "working" there was never clocked out.
  const map = {
    'not-started': ['Not clocked in', ''],
    working: isToday ? ['Working', 'pill--ok'] : ['No clock-out', 'pill--warn'],
    'at-lunch': ['At lunch', 'pill--warn'],
    'on-break': ['On break', 'pill--warn'],
    done: [isToday ? 'Done for today' : 'Done', 'pill--accent'],
  } as const;
  const [label, cls] = map[state];
  return <span className={`pill ${cls}`}>{label}</span>;
}
