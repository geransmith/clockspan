import { useMemo, type ReactNode } from 'react';
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
import { computeTimeclock } from '../lib/timeclock';
import { endOfDay } from '../lib/format';
import type { CardId } from '../types';
import { CardShell } from './CardShell';
import { FocusTimer } from './FocusTimer';
import { Priorities } from './Priorities';
import { SessionLog } from './SessionLog';
import { Timeclock } from './Timeclock';

interface Props {
  date: string;
  today: string;
  now: number;
  customize: boolean;
}

export function Sheet({ date, today, now, customize }: Props) {
  const { settings, update } = useSettings();
  const { day, store } = useDay(date);
  const isToday = date === today;
  // A past day is frozen at its end so an unclosed clock-in doesn't count forever.
  const effectiveNow = isToday ? now : Math.min(now, endOfDay(date));
  const tc = useMemo(
    () => (day ? computeTimeclock(day.punches, settings, effectiveNow, { frozen: !isToday }) : null),
    [day, settings, effectiveNow, isToday],
  );

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

  if (!day || !tc) return <div className="sheet-loading" aria-busy="true" />;

  const render = (id: CardId) => {
    switch (id) {
      case 'timeclock':
        return <Timeclock date={date} isToday={isToday} now={effectiveNow} punches={day.punches} tc={tc} onChange={(p) => void store.setPunches(date, p)} />;
      case 'priorities':
        return <Priorities date={date} priorities={day.priorities} onChange={(p) => void store.setPriorities(date, p)} />;
      case 'timer':
        return <FocusTimer date={date} isToday={isToday} />;
      case 'log':
        return <SessionLog date={date} sessions={day.sessions} now={now} />;
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
    <div ref={setNodeRef} style={style} className="sortable">
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

function StatePill({ state }: { state: ReturnType<typeof computeTimeclock>['state'] }) {
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
