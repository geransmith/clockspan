import { lazy, Suspense, useEffect, useState } from 'react';
import { useDay } from '../hooks/useDay';
import { useLeftOpen } from '../hooks/useLeftOpen';
import { useRange } from '../hooks/useRange';
import { useSettings } from '../hooks/useSettings';
import { warnQuietly } from '../lib/alerts';
import { LOAD_FAILED, PUNCH_ORDER, SAVE_FAILED } from '../lib/copy';
import { startOfWeek } from '../../../shared/dates.js';
import { dayName } from '../lib/format';
import { CARD_TITLES, moveCard, setCardSide, setCardVisible, SPLIT_QUERY, splitColumns } from '../lib/layout';
import { hasText } from '../../../shared/priorities.js';
import { CARD_SIDES } from '../../../shared/settings.js';
import { focusOf } from '../lib/retro';
import { clampToDay, dayTimeclock, type TimeclockState } from '../lib/timeclock';
import { weekHours } from '../lib/week';
import type { CardId, CardSide } from '../types';
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
  now: number;
  customize: boolean;
  /** A card to scroll into view once the sheet has rendered (a banner's "Open …" button). */
  jumpTo: CardId | null;
  onJumped: () => void;
  /** See `Timeclock.onEditingChange`. */
  onPunchEditing: (editing: boolean) => void;
}

export function Sheet({ date, today, now, customize, jumpTo, onJumped, onPunchEditing }: Props) {
  const { settings, update } = useSettings();
  const { day, failed, store } = useDay(date);
  const isToday = date === today;
  const tc = day ? dayTimeclock(day, settings, today, now) : null;
  // The week so far, up to this sheet's day, for the timeclock's week line.
  const { days: weekDays } = useRange(startOfWeek(date), date);
  const week = weekDays ? weekHours(weekDays, settings, today, now) : null;
  const focus = focusOf(day?.sessions ?? []);
  // Today's list with nothing written yet offers what the last planned day left unticked.
  const { leftOpen, dismiss: dismissLeftOpen } = useLeftOpen(today, isToday && day != null && !day.priorities.some(hasText));

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
  const saveLayout = (next: typeof layout) => update({ layout: next }).catch(() => warnQuietly({ ...SAVE_FAILED, tag: 'save-failed' }));
  const reorder = (from: number, to: number, side?: CardSide) => {
    const next = moveCard(layout, from, to, side);
    if (next) void saveLayout(next);
  };
  const setVisible = (id: CardId, v: boolean) => void saveLayout(setCardVisible(layout, id, v));
  // A card moved to the other column mounts again there, and the focus goes with the old
  // button, so the card's arrow in its new place takes it. A new object each move runs the
  // effect again for the same card.
  const [swapped, setSwapped] = useState<{ id: CardId } | null>(null);
  const setSide = (id: CardId, side: CardSide) => {
    setSwapped({ id });
    void saveLayout(setCardSide(layout, id, side));
  };
  useEffect(() => {
    if (swapped) document.querySelector<HTMLElement>(`#card-${swapped.id} [data-swap]`)?.focus();
  }, [swapped]);

  const ready = day != null;
  useEffect(() => {
    if (!jumpTo || !ready) return;
    document
      .getElementById(`card-${jumpTo}`)
      ?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
    onJumped();
  }, [jumpTo, ready, onJumped]);

  // The split class goes on while a day loads too, so the page keeps its width when ◀ or ▶ opens
  // a day the store doesn't hold yet.
  const sheetClass = columns ? 'sheet sheet--split' : 'sheet';
  if (!day || !tc)
    return (
      <div className={sheetClass}>
        {failed ? <LoadFailed title={LOAD_FAILED.title} onRetry={() => void store.load(date)} /> : <div className="sheet-loading" aria-busy="true" />}
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
          />
        );
      case 'priorities':
        return (
          <Priorities
            key={date}
            priorities={day.priorities}
            sessions={day.sessions}
            onChange={(p, base) => void store.setPriorities(date, p, base)}
            leftOpen={
              leftOpen && {
                from: dayName(leftOpen.date, today, true),
                rows: leftOpen.rows,
                dismiss: dismissLeftOpen,
              }
            }
          />
        );
      case 'timer':
        return <FocusTimer date={date} isToday={isToday} priorities={day.priorities} onAddPriority={(text) => store.addPriority(date, text)} />;
      case 'log':
        return <SessionLog date={date} isToday={isToday} sessions={day.sessions} breaks={day.breaks} priorities={day.priorities} now={now} />;
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
      aside: l.id === 'timeclock' ? <StatePill state={tc.state} isToday={isToday} /> : undefined,
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
      {tc.outOfOrder && <div className="notice notice--danger">{PUNCH_ORDER}</div>}
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
            <button key={l.id} className="chip" onClick={() => setVisible(l.id, true)}>
              {CARD_TITLES[l.id]} <span className="chip-action">Show</span>
            </button>
          ))}
        </div>
      )}
      {visible.length === 0 && !customize && <p className="muted center">All cards are hidden. Use Customize to show them.</p>}
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
