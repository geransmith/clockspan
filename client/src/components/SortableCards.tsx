import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { CARD_TITLES } from '../lib/layout';
import type { CardId } from '../types';
import { CardFrame, type SheetCard } from './CardFrame';

/**
 * The sheet's cards with drag and drop, in a chunk of its own: dnd-kit is only needed once
 * the user customizes, so the first load goes without it (`Sheet.tsx` loads this lazily).
 */
export function SortableCards({ cards, onReorder }: { cards: SheetCard[]; onReorder: (from: number, to: number) => void }) {
  const sensors = useSensors(
    // Covers touch too: the pointer sensor claims a gesture on pointerdown, before touchstart, so a touch
    // sensor here would never run; the grip's touch-action: none keeps a finger on it from scrolling the page.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const indexOf = (id: UniqueIdentifier) => cards.findIndex((c) => c.id === id);
  const onDragEnd = (e: DragEndEvent) => {
    const over = e.over;
    if (!over || e.active.id === over.id) return;
    onReorder(indexOf(e.active.id), indexOf(over.id));
  };
  // dnd-kit's defaults read the raw ids ("draggable item log"). onDragOver also fires at pickup,
  // with the card over itself, so it states where the card is rather than a move.
  const title = (id: UniqueIdentifier) => CARD_TITLES[id as CardId];
  const place = (id: UniqueIdentifier) => `position ${indexOf(id) + 1} of ${cards.length}`;
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${title(active.id)}.`,
    onDragOver: ({ active, over }) => `${title(active.id)} is at ${place((over ?? active).id)}.`,
    onDragEnd: ({ active, over }) => `Dropped ${title(active.id)} at ${place((over ?? active).id)}.`,
    onDragCancel: ({ active }) => `Move cancelled. ${title(active.id)} is back at ${place(active.id)}.`,
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} accessibility={{ announcements }}>
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
