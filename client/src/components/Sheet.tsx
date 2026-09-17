import { useEffect, useMemo, type ReactNode } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useDay } from '../hooks/useDay';
import { useSettings } from '../hooks/useSettings';
import { cardTitle } from '../lib/layout';
import { clampToDay, timeclockForDate, type TimeclockState } from '../lib/timeclock';
import type { CardId } from '../types';
import { CardShell } from './CardShell';
import { FocusTimer } from './FocusTimer';
import { Priorities } from './Priorities';
import { Retro } from './Retro';
import { SessionLog } from './SessionLog';
import { Timeclock } from './Timeclock';

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
  const tc = useMemo(() => (day ? timeclockForDate(day.punches, settings, date, today, now) : null), [day, settings, date, today, now]);

  const layout = settings.layout;
  const visible = layout.filter((l) => l.visible);
  const hidden = layout.filter((l) => !l.visible);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    // Long-press on touch so normal scrolling isn't hijacked.
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const reorder = (from: number, to: number) => {
    if (from === to || to < 0 || to >= visible.length) return;
    const nextVisible = arrayMove(visible, from, to);
    void update({ layout: [...nextVisible, ...hidden] });
  };
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    reorder(
      visible.findIndex((l) => l.id === e.active.id),
      visible.findIndex((l) => l.id === e.over!.id),
    );
  };
  const setVisible = (id: CardId, v: boolean) => {
    void update({ layout: layout.map((l) => (l.id === id ? { ...l, visible: v } : l)) });
  };

  const ready = Boolean(day && tc);
  useEffect(() => {
    if (!jumpTo || !ready) return;
    document.getElementById(`card-${jumpTo}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    onJumped?.();
  }, [jumpTo, ready, onJumped]);

  if (!day || !tc) return <div className="sheet-loading" aria-busy="true" />;

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
            onChange={(p) => void store.setPunches(date, p)}
            onOvertimeChange={(v) => void store.setOvertimeApproved(date, v)}
            onEditingChange={onPunchEditing}
          />
        );
      case 'priorities':
        return <Priorities key={date} priorities={day.priorities} onChange={(p) => void store.setPriorities(date, p)} />;
      case 'timer':
        return <FocusTimer date={date} isToday={isToday} priorities={day.priorities} onAddPriority={(text) => store.addPriority(date, text)} />;
      case 'log':
        return <SessionLog date={date} sessions={day.sessions} priorities={day.priorities} now={now} />;
      case 'retro':
        return (
          <Retro
            key={date}
            priorities={day.priorities}
            sessions={day.sessions}
            note={day.retroNote}
            reviewedAt={day.retroAt}
            onChange={(patch) => void store.setRetro(date, patch)}
          />
        );
    }
  };

  return (
    <div className="sheet">
      {tc.error && <div className="notice notice--danger">{tc.error}</div>}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={visible.map((l) => l.id)} strategy={verticalListSortingStrategy}>
          {visible.map((l, i) => (
            <SortableCard
              key={l.id}
              id={l.id}
              customize={customize}
              onHide={() => setVisible(l.id, false)}
              onMove={(dir) => reorder(i, i + dir)}
              canUp={i > 0}
              canDown={i < visible.length - 1}
              aside={l.id === 'timeclock' ? <StatePill state={tc.state} /> : undefined}
            >
              {render(l.id)}
            </SortableCard>
          ))}
        </SortableContext>
      </DndContext>
      {customize && hidden.length > 0 && (
        <div className="hidden-strip">
          <span className="muted">Hidden:</span>
          {hidden.map((l) => (
            <button key={l.id} className="chip" onClick={() => setVisible(l.id, true)}>
              {cardTitle(l.id)} <span className="chip-action">Show</span>
            </button>
          ))}
        </div>
      )}
      {visible.length === 0 && !customize && <p className="muted center">All cards are hidden. Use Customize to show them.</p>}
    </div>
  );
}

function SortableCard({
  id,
  customize,
  children,
  onHide,
  onMove,
  canUp,
  canDown,
  aside,
}: {
  id: CardId;
  customize: boolean;
  children: ReactNode;
  onHide: () => void;
  onMove: (dir: -1 | 1) => void;
  canUp: boolean;
  canDown: boolean;
  aside?: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: !customize });
  const style = { transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 2 : undefined, opacity: isDragging ? 0.85 : undefined };
  return (
    <div ref={setNodeRef} style={style} className="sortable" id={`card-${id}`}>
      <CardShell
        title={cardTitle(id)}
        aside={aside}
        customize={customize ? { handleProps: { ...attributes, ...listeners }, onHide, onMove, canUp, canDown } : undefined}
      >
        {children}
      </CardShell>
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
