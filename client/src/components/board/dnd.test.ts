// @vitest-environment happy-dom
import type { Active, ClientRect, DraggableNode, DroppableContainer, UniqueIdentifier } from '@dnd-kit/core';
import { describe, expect, it } from 'vitest';
import { columnDropId, COLUMNS, type ColumnId } from '../../lib/board';
import { boardCollision, boardKeyboardCoordinates } from './dnd';

// Four columns side by side, 280 px wide; cards 256 × 40 px, 50 px apart, from y 150.
const rect = (left: number, top: number, width = 256, height = 40): ClientRect => ({ left, top, width, height, right: left + width, bottom: top + height });
const colRect = (i: number) => rect(i * 300, 100, 280, 600);
const cardRect = (col: number, i: number) => rect(col * 300 + 12, 150 + i * 50);
/** Where a column not shown on a phone, and each of its cards, measures. */
const NOWHERE = rect(0, 0, 0, 0);

function droppable(id: string, r: ClientRect, lane?: { id: string; index: number; items: string[] }): DroppableContainer {
  const node = document.createElement('div');
  document.body.append(node);
  return {
    id,
    key: id,
    disabled: false,
    node: { current: node },
    rect: { current: r },
    data: { current: lane ? { sortable: { containerId: lane.id, index: lane.index, items: lane.items } } : {} },
  };
}

interface BoardShape {
  /** Next's cards and where each sits: by default d level with Later's first card, e lower than Later's last. */
  next?: Record<string, ClientRect>;
  /** The one column a phone shows: the others, and their cards, measure 0 × 0 at the corner. */
  shown?: ColumnId;
}

/** Later holds a and b, Next holds `next`; In Progress and Done take drops as columns. */
function board({ next = { d: cardRect(1, 0), e: cardRect(1, 2) }, shown }: BoardShape = {}) {
  const at = (column: ColumnId, r: ClientRect) => (shown === undefined || shown === column ? r : NOWHERE);
  const later = ['a', 'b'];
  const nextIds = Object.keys(next);
  const containers = [
    ...COLUMNS.map((c, i) => droppable(columnDropId(c), at(c, colRect(i)))),
    ...later.map((id, index) => droppable(id, at('later', cardRect(0, index)), { id: 'later', index, items: later })),
    ...nextIds.map((id, index) => droppable(id, at('next', next[id]!), { id: 'next', index, items: nextIds })),
  ];
  return { containers, rects: new Map(containers.map((c) => [c.id, c.rect.current!])) };
}

const active = (id: string): Active => ({ id, data: { current: {} }, rect: { current: { initial: null, translated: null } } });

describe('boardCollision', () => {
  const collide = (pointer: { x: number; y: number } | null, collisionRect: ClientRect, nextEmpty = false) => {
    const { containers, rects } = board(nextEmpty ? { next: {} } : {});
    return boardCollision({ active: active('x'), collisionRect, droppableRects: rects, droppableContainers: containers, pointerCoordinates: pointer })[0]?.id;
  };

  it('takes the nearest card of Later or Next under the pointer, so the card sorts among them', () => {
    expect(collide({ x: 100, y: 215 }, cardRect(0, 1))).toBe('b');
    expect(collide({ x: 100, y: 400 }, rect(12, 390))).toBe('b');
    expect(collide({ x: 400, y: 160 }, cardRect(1, 0))).toBe('d');
  });

  it('takes an empty lane, In Progress and Done as columns', () => {
    expect(collide({ x: 400, y: 300 }, rect(312, 290), true)).toBe(columnDropId('next'));
    expect(collide({ x: 700, y: 160 }, rect(612, 150))).toBe(columnDropId('progress'));
    expect(collide({ x: 1000, y: 500 }, rect(912, 490))).toBe(columnDropId('done'));
  });

  it('takes what the dragged card overlaps most without a pointer (a keyboard drag) or with it in a gap', () => {
    expect(collide(null, cardRect(1, 0))).toBe('d');
    expect(collide(null, rect(612, 150))).toBe(columnDropId('progress'));
    expect(collide({ x: 590, y: 160 }, rect(600, 150))).toBe(columnDropId('progress'));
    expect(collide(null, rect(5000, 5000))).toBeUndefined();
  });
});

describe('boardKeyboardCoordinates', () => {
  /** dnd-kit's droppable map, as the sensor's context holds it. */
  class Containers extends Map<UniqueIdentifier, DroppableContainer> {
    override get(id: UniqueIdentifier | null | undefined) {
      return id == null ? undefined : super.get(id);
    }
    toArray() {
      return [...this.values()];
    }
    getEnabled() {
      return this.toArray().filter((c) => !c.disabled);
    }
    getNodeFor(id: UniqueIdentifier | null | undefined) {
      return this.get(id)?.node.current ?? undefined;
    }
  }

  /** Where `code` takes `id`, a lane's card at its own rect or a plain draggable of `column` at `at`. */
  function press(code: string, id: string, { at = cardRect(0, 0), column, ...shape }: { at?: ClientRect; column?: unknown } & BoardShape = {}) {
    const { containers, rects } = board(shape);
    const node: DraggableNode = {
      id,
      key: id,
      node: { current: null },
      activatorNode: { current: null },
      data: { current: column === undefined ? {} : { column } },
    };
    const event = new KeyboardEvent('keydown', { code, cancelable: true });
    const coordinates = boardKeyboardCoordinates(event, {
      active: id,
      currentCoordinates: { x: at.left, y: at.top },
      context: {
        activatorEvent: null,
        active: active(id),
        activeNode: null,
        collisionRect: at,
        collisions: null,
        draggableNodes: new Map([[id, node]]),
        draggingNode: null,
        draggingNodeRect: null,
        droppableRects: rects,
        droppableContainers: new Containers(containers.map((c) => [c.id, c])),
        over: null,
        scrollableAncestors: [],
        scrollAdjustedTranslate: null,
      },
    });
    return { coordinates, prevented: event.defaultPrevented };
  }

  it('sorts a card of Later or Next up and down among its own lane only', () => {
    expect(press('ArrowDown', 'a').coordinates).toEqual({ x: 12, y: 200 });
    expect(press('ArrowUp', 'b', { at: cardRect(0, 1) }).coordinates).toEqual({ x: 12, y: 150 });
    // The last card of Later goes no lower, though Next's card sits lower beside it.
    expect(press('ArrowDown', 'b', { at: cardRect(0, 1) }).coordinates).toBeUndefined();
  });

  it("takes a card to the next column's cards, or to the column when it shows none", () => {
    expect(press('ArrowRight', 'a').coordinates).toEqual({ x: 312, y: 150 });
    expect(press('ArrowRight', 'a', { next: {} }).coordinates).toEqual({ x: 300, y: 100 });
    // Next's one card sits far down, and the column's corners are nearer: the card is still where it goes.
    expect(press('ArrowRight', 'a', { next: { f: cardRect(1, 10) } }).coordinates).toEqual({ x: 312, y: 650 });
  });

  it('reaches no column a phone leaves out, so ← and → do nothing there', () => {
    expect(press('ArrowLeft', 'b', { at: cardRect(0, 1), shown: 'later' })).toEqual({ coordinates: undefined, prevented: true });
    expect(press('ArrowDown', 'a', { shown: 'later' }).coordinates).toEqual({ x: 12, y: 200 });
    expect(press('ArrowLeft', 'row', { at: rect(612, 150), column: 'progress', shown: 'progress' }).coordinates).toBeUndefined();
  });

  it('moves an item of In Progress or Done sideways only, its column standing in for it', () => {
    const inProgress = { at: rect(612, 150), column: 'progress' };
    expect(press('ArrowLeft', 'row', inProgress).coordinates).toEqual({ x: 312, y: 150 });
    expect(press('ArrowRight', 'row', inProgress).coordinates).toEqual({ x: 900, y: 100 });
    const up = press('ArrowUp', 'row', inProgress);
    expect(up).toEqual({ coordinates: undefined, prevented: true });
  });

  it('does nothing for an item it cannot place', () => {
    expect(press('ArrowLeft', 'row', { at: rect(612, 150), column: 'nowhere' }).coordinates).toBeUndefined();
    expect(press('ArrowLeft', 'row', { at: rect(612, 150) }).coordinates).toBeUndefined();
  });
});
