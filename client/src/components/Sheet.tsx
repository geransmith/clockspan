import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useDay } from '../hooks/useDay';
import { useLeftOpen } from '../hooks/useLeftOpen';
import { useWeek } from '../hooks/useWeek';
import { useSettings } from '../hooks/useSettings';
import { warnQuietly } from '../lib/alerts';
import { LOAD_FAILED, SAVE_FAILED } from '../lib/copy';
import { addDays, formatDateLong } from '../lib/format';
import { CARD_TITLES, moveCard, setCardVisible } from '../lib/layout';
import { daySummaryOf } from '../lib/stickers';
import { clampToDay, daySettings, timeclockForDate, type TimeclockState } from '../lib/timeclock';
import { weekHours } from '../lib/week';
import type { CardId } from '../types';
import { CardFrame, type SheetCard } from './CardFrame';
import { FocusTimer } from './FocusTimer';
import { Priorities } from './Priorities';
import { Retro } from './Retro';
import { SessionLog } from './SessionLog';
import { Timeclock } from './Timeclock';

const SortableCards = lazy(() => import('./SortableCards').then((m) => ({ default: m.SortableCards })));

interface Props {
  date: string;
  today: string;
  now: number;
  customize: boolean;
  /** A card to scroll into view once the sheet has rendered (a banner's "Open …" button). */
  jumpTo?: CardId | null;
  onJumped?: () => void;
  /** See `Timeclock.onEditingChange`. */
  onPunchEditing?: (editing: boolean) => void;
}

export function Sheet({ date, today, now, customize, jumpTo, onJumped, onPunchEditing }: Props) {
  const { settings, update } = useSettings();
  const { day, store } = useDay(date);
  const isToday = date === today;
  const tc = useMemo(() => (day ? timeclockForDate(day.punches, daySettings(settings, day), date, today, now) : null), [day, settings, date, today, now]);
  // The week so far, up to this sheet's day, for the timeclock's week line.
  const weekDays = useWeek(date);
  const week = useMemo(() => (weekDays ? weekHours(weekDays, settings, date, today, now) : null), [weekDays, settings, date, today, now]);
  const focus = useMemo(
    () => ({ seconds: day ? daySummaryOf(day).focusSeconds : 0, sessions: day?.sessions.filter((s) => s.status === 'completed').length ?? 0 }),
    [day],
  );
  // Today's list with nothing written yet offers what the last planned day left unticked.
  const { leftOpen, dismiss: dismissLeftOpen } = useLeftOpen(today, isToday && day != null && !day.priorities.some((p) => p.text.trim()));

  const layout = settings.layout;
  const visible = layout.filter((l) => l.visible);
  const hidden = layout.filter((l) => !l.visible);

  // Drag and drop loads with the first Customize, and the sheet stays on it after that:
  // swapping lists remounts every card, which drops what is typed but not saved (a timer
  // label, an open planner), so that happens once at most.
  const [sortable, setSortable] = useState(customize);
  if (customize && !sortable) setSortable(true);

  // The provider puts the old layout back on failure; the banner is the only sign it happened.
  const saveLayout = (next: typeof layout) =>
    update({ layout: next }).catch(() => warnQuietly({ title: SAVE_FAILED.title, body: SAVE_FAILED.body, tag: 'save-failed' }));
  const reorder = (from: number, to: number) => {
    const next = moveCard(layout, from, to);
    if (next) void saveLayout(next);
  };
  const setVisible = (id: CardId, v: boolean) => void saveLayout(setCardVisible(layout, id, v));

  const ready = Boolean(day && tc);
  useEffect(() => {
    if (!jumpTo || !ready) return;
    document.getElementById(`card-${jumpTo}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    onJumped?.();
  }, [jumpTo, ready, onJumped]);

  if (!day || !tc) {
    if (store.errors[date]) {
      return (
        <div className="notice notice--danger sheet-error" role="alert">
          <span>
            <strong>{LOAD_FAILED.title}.</strong> {LOAD_FAILED.body}
          </span>
          <button className="btn" onClick={() => void store.load(date)}>
            {LOAD_FAILED.retry}
          </button>
        </div>
      );
    }
    return <div className="sheet-loading" aria-busy="true" />;
  }

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
            onChange={(p) => void store.setPriorities(date, p)}
            leftOpen={
              leftOpen && {
                from: leftOpen.date === addDays(today, -1) ? 'yesterday' : formatDateLong(leftOpen.date),
                rows: leftOpen.rows,
                dismiss: dismissLeftOpen,
              }
            }
          />
        );
      case 'timer':
        return <FocusTimer date={date} isToday={isToday} priorities={day.priorities} onAddPriority={(text) => store.addPriority(date, text)} />;
      case 'log':
        return <SessionLog date={date} sessions={day.sessions} priorities={day.priorities} now={now} />;
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
            onChange={(patch) => void store.setRetro(date, patch)}
          />
        );
    }
  };

  const cards: SheetCard[] = visible.map((l, i) => ({
    id: l.id,
    body: render(l.id),
    aside: l.id === 'timeclock' ? <StatePill state={tc.state} /> : undefined,
    customize: customize
      ? { onHide: () => setVisible(l.id, false), onMove: (dir) => reorder(i, i + dir), canUp: i > 0, canDown: i < visible.length - 1 }
      : undefined,
  }));
  const plain = cards.map((c) => <CardFrame key={c.id} card={c} />);

  return (
    <div className="sheet">
      {tc.error && <div className="notice notice--danger">{tc.error}</div>}
      {sortable ? (
        <Suspense fallback={plain}>
          <SortableCards cards={cards} onReorder={reorder} />
        </Suspense>
      ) : (
        plain
      )}
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

function StatePill({ state }: { state: TimeclockState }) {
  const map = {
    'not-started': ['Not clocked in', ''],
    working: ['Working', 'pill--ok'],
    'at-lunch': ['At lunch', 'pill--warn'],
    'on-break': ['On break', 'pill--warn'],
    done: ['Done for today', 'pill--accent'],
  } as const;
  const [label, cls] = map[state];
  return <span className={`pill ${cls}`}>{label}</span>;
}
