/**
 * The board's drag and drop settings for dnd-kit: which droppable a card is over
 * (`boardCollision`) and where the arrow keys take it (`boardKeyboardCoordinates`). Every column
 * is a droppable (`columnDropId`); Later's and Next's cards are sortable too, each lane in a
 * SortableContext whose id is the lane, while In Progress and Done take a drop as a whole column
 * and their items, like a recurring priority's card in Later's Repeats, are plain draggables.
 * Here, beside `Board`, so the dnd-kit imports stay in the board's lazy chunk; where a drop lands
 * is `dropTarget` (`lib/board.ts`).
 */
import {
  closestCorners,
  pointerWithin,
  rectIntersection,
  type CollisionDetection,
  type DroppableContainer,
  type KeyboardCoordinateGetter,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { hasSortableData, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { columnDropId, COLUMNS, type ColumnId } from '../../lib/board';
import type { OpenLane } from '../../types';
import { OPEN_LANES } from '../../../../shared/api.js';

/** A droppable that is one of `lane`'s cards. */
const inLane = (c: DroppableContainer, lane: OpenLane) => hasSortableData(c) && c.data.current.sortable.containerId === lane;

/** The lane whose column this droppable is, while some card shows in it. */
function fullLane(c: DroppableContainer, all: DroppableContainer[]): OpenLane | undefined {
  return OPEN_LANES.find((lane) => c.id === columnDropId(lane) && all.some((card) => inLane(card, lane)));
}

/**
 * What the dragged card is over: the droppable under the pointer, else (a keyboard drag, or the
 * pointer in a gap) the one the card overlaps most. Over Later or Next while it shows cards, the
 * nearest of them, so the card sorts in among them; over In Progress or Done, the column.
 */
export const boardCollision: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  const hits = within.length > 0 ? within : rectIntersection(args);
  const first = hits[0] && args.droppableContainers.find((c) => c.id === hits[0]!.id);
  const lane = first && fullLane(first, args.droppableContainers);
  return lane ? closestCorners({ ...args, droppableContainers: args.droppableContainers.filter((c) => inLane(c, lane)) }) : hits;
};

/** The column a plain draggable (a row or card of In Progress or Done, or of Later's Repeats) says it shows in. */
function draggableColumn(data: Record<string, unknown> | undefined): ColumnId | undefined {
  const column = data?.column;
  return COLUMNS.find((c) => c === column);
}

/** A stand-in: the droppable that answers for the dragged item when it is no droppable of its own. */
interface StandIn {
  id: UniqueIdentifier;
  container: DroppableContainer;
}

/** A droppable list read the way dnd-kit's own map is (the sortable getter calls `get` and `getEnabled`). */
class Droppables extends Map<UniqueIdentifier, DroppableContainer> {
  readonly stand: StandIn | null;
  constructor(entries: DroppableContainer[], stand: StandIn | null) {
    super(entries.map((c) => [c.id, c]));
    this.stand = stand;
  }
  override get(id: UniqueIdentifier | null | undefined): DroppableContainer | undefined {
    if (id == null) return undefined;
    return super.get(id) ?? (id === this.stand?.id ? this.stand.container : undefined);
  }
  toArray(): DroppableContainer[] {
    return [...this.values()];
  }
  getEnabled(): DroppableContainer[] {
    return this.toArray().filter((c) => !c.disabled);
  }
  getNodeFor(id: UniqueIdentifier | null | undefined): HTMLElement | undefined {
    return this.get(id)?.node.current ?? undefined;
  }
}

/**
 * Where an arrow key takes a dragged card: dnd-kit's sortable getter (the nearest droppable that
 * way) over the droppables the key can reach. ↑ and ↓ sort a card among its lane's cards, and do
 * nothing in In Progress or Done, which don't sort, or for a card of Later's Repeats. ← and →
 * reach the other columns: Later's and Next's cards while they show any (so the card sorts in
 * among them), else the column. A row or card of In Progress or Done, or of Later's Repeats, is no
 * droppable of its own, which the sortable getter needs: its column stands in for it, and is left
 * out of the way. Below 900 px the columns not shown stay mounted, measured 0 × 0 at the page's
 * corner: none is reached, so ← and → do nothing there.
 */
export const boardKeyboardCoordinates: KeyboardCoordinateGetter = (event, args) => {
  const { active } = args;
  const { droppableContainers, draggableNodes, droppableRects } = args.context;
  const all = droppableContainers.toArray().filter((c) => {
    const r = droppableRects.get(c.id);
    return r !== undefined && r.width > 0 && r.height > 0;
  });
  const vertical = event.code === 'ArrowUp' || event.code === 'ArrowDown';
  const own = droppableContainers.get(active);
  let stand: StandIn | null = null;
  let kept: DroppableContainer[];
  if (own) {
    const lane = OPEN_LANES.find((l) => inLane(own, l));
    kept = all.filter((c) => (vertical ? lane !== undefined && inLane(c, lane) : !fullLane(c, all)));
  } else {
    const column = draggableColumn(draggableNodes.get(active)?.data.current);
    const container = column && droppableContainers.get(columnDropId(column));
    if (!container) return undefined;
    stand = { id: active, container };
    kept = vertical ? [] : all.filter((c) => c !== container && !fullLane(c, all));
  }
  return sortableKeyboardCoordinates(event, { ...args, context: { ...args.context, droppableContainers: new Droppables(kept, stand) } });
};
