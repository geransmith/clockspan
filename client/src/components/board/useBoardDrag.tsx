import {
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors,
  type Announcements,
  type DragCancelEvent,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import {
  COLUMN_NAMES,
  dropTarget,
  findItem,
  moveAnnouncement,
  overAnnouncement,
  withDrag,
  type BoardColumns,
  type BoardItem,
  type ColumnId,
  type DropTarget,
} from '../../lib/board';
import { BOARD_DRAG } from '../../lib/copy';
import type { Category } from '../../types';
import { Grip } from '../Icons';
import { CategoryTag, type ItemDrag } from './BoardCard';
import { boardCollision, boardKeyboardCoordinates } from './dnd';

/** The dragged item's place in its list while the copy under the pointer moves. */
const DRAGGED_OPACITY = 0.4;

/** Planned items (their day's list decides them) and recurring rows (they stay on today's list) have no grip. */
export const canDrag = (item: BoardItem) => !item.planned && !item.recurring;

/** The board's focus as a drag ends: `clear` drops one an earlier move left, and `afterKeyboard` sends it to the item's grip. */
interface DragFocus {
  clear: () => void;
  afterKeyboard: (id: string) => void;
}

/**
 * The board's drag and drop. `shown` is `columns` as the drag shows them (the item in the column
 * it is over); `over` is that column, for its outline; `lifted` is the item the copy under the
 * pointer draws; `dropAnimation` is the overlay's, none with reduced motion. `context` gives
 * `DndContext` its sensors, collision, start and over handlers and what a screen reader hears.
 * `onDragEnd` and `onDragCancel` take the board's `run` and focus as well: Board passes them in
 * closures, since the refs lint refuses a call in render handed functions that write refs.
 */
export function useBoardDrag(columns: BoardColumns | null) {
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
  // The columns as the drag shows them.
  const shown = useMemo(() => (columns && dragged && preview ? withDrag(columns, dragged, preview) : columns), [columns, dragged, preview]);

  // Read only by the handlers below, and Board renders the DndContext only once its columns have loaded.
  const cols = shown!;
  const find = (id: UniqueIdentifier) => findItem(cols, String(id));
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
    const target = dropTarget(String(over.id), found.item.id, cols);
    const to = target?.to ?? found.item.column;
    if (to !== found.column) setPreview(target && to !== found.item.column ? target : null);
  };
  // dnd-kit's own focus return is off (it would take the focus from the notice a drop brings), so
  // a keyboard drag gets it back here: on the item's grip, where the move sends the item or where
  // it stays.
  const end = (item: BoardItem | undefined, activatorEvent: Event | null, focus: DragFocus) => {
    setDragged(null);
    setPreview(null);
    if (!item || !(activatorEvent instanceof globalThis.KeyboardEvent)) return;
    focus.afterKeyboard(item.id);
  };
  const onDragEnd = (
    { active, over, activatorEvent }: DragEndEvent,
    run: (item: BoardItem, to: ColumnId, before: string | null, options: { at?: DOMRect }) => string,
    focus: DragFocus,
  ) => {
    const item = find(active.id)?.item;
    focus.clear();
    if (item) {
      // The tick's burst starts where the card was let go.
      const r = active.rect.current.translated;
      const at = r ? new DOMRect(r.left, r.top, r.width, r.height) : undefined;
      const target = dropTarget(over ? String(over.id) : null, item.id, cols);
      dropLine.current = target ? run(item, target.to, target.before, { at }) : moveAnnouncement(null, item, item.column);
    }
    end(item, activatorEvent, focus);
  };
  const onDragCancel = ({ active, activatorEvent }: DragCancelEvent, focus: DragFocus) => {
    focus.clear();
    end(find(active.id)?.item, activatorEvent, focus);
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
      const target = dropTarget(String(over.id), item.id, cols);
      return target || !first ? overAnnouncement(target, item, cols) : undefined;
    },
    onDragEnd: () => dropLine.current,
    onDragCancel: ({ active }) => {
      const item = find(active.id)?.item;
      return item && BOARD_DRAG.cancelled(item.title, COLUMN_NAMES[item.column]);
    },
  };

  return {
    shown,
    over: preview?.to,
    // Worked out above Board's loading return, which a drag can fall back to (today moving at midnight).
    lifted: dragged && shown ? findItem(shown, dragged)?.item : undefined,
    dropAnimation: reduceMotion ? null : undefined,
    context: { sensors, collisionDetection: boardCollision, accessibility: { announcements, restoreFocus: false }, onDragStart, onDragOver },
    onDragEnd,
    onDragCancel,
  };
}

/** A card of Later or Next: the others in its lane make room as it is dragged among them. `held`: not picked up meanwhile (`entry`). */
export function SortableEntry({ id, held, render }: { id: string; held: boolean; render: (drag: ItemDrag) => ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: { draggable: held, droppable: false } });
  return render({
    nodeRef: setNodeRef,
    style: { transform: CSS.Translate.toString(transform), transition, opacity: isDragging ? DRAGGED_OPACITY : undefined },
    handleProps: { ...attributes, ...listeners },
  });
}

/** A row or card of In progress or Done, which neither sorts: `column` tells the keyboard where it shows (`boardKeyboardCoordinates`); `held` as above. */
export function DraggableEntry({ id, column, held, render }: { id: string; column: ColumnId; held: boolean; render: (drag: ItemDrag) => ReactNode }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id, data: { column }, disabled: held });
  return render({ nodeRef: setNodeRef, style: { opacity: isDragging ? DRAGGED_OPACITY : undefined }, handleProps: { ...attributes, ...listeners } });
}

/** The card under the pointer as it is dragged: its title and category, with the grip it was picked up by. */
export function Lifted({ item, category }: { item: BoardItem; category?: Category }) {
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
          <CategoryTag category={category} />
        </p>
      )}
    </div>
  );
}
