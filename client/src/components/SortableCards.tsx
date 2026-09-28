import { DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { CardFrame, type SheetCard } from './CardFrame';

/**
 * The sheet's cards with drag and drop, in a chunk of its own: dnd-kit is only needed once
 * the user customizes, so the first load goes without it (`Sheet.tsx` loads this lazily).
 */
export function SortableCards({ cards, onReorder }: { cards: SheetCard[]; onReorder: (from: number, to: number) => void }) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    // Long-press on touch so normal scrolling isn't hijacked.
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = (e: DragEndEvent) => {
    const over = e.over;
    if (!over || e.active.id === over.id) return;
    onReorder(
      cards.findIndex((c) => c.id === e.active.id),
      cards.findIndex((c) => c.id === over.id),
    );
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        {cards.map((c) => (
          <SortableCard key={c.id} card={c} />
        ))}
      </SortableContext>
    </DndContext>
  );
}

function SortableCard({ card }: { card: SheetCard }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: card.id, disabled: !card.customize });
  const style = { transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 2 : undefined, opacity: isDragging ? 0.85 : undefined };
  return <CardFrame card={card} nodeRef={setNodeRef} style={style} handleProps={{ ...attributes, ...listeners }} />;
}
