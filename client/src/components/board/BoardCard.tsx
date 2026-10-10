import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core';
import type { CSSProperties } from 'react';
import { hasNote } from '../../../../shared/text.js';
import { categoryOf, type BoardItem, type CategoryPick } from '../../lib/board';
import { dayName } from '../../lib/format';
import type { Category, Session } from '../../types';
import { CategoryDot } from '../CategoryDot';
import { Note } from '../Icons';
import { RepeatMark } from '../RepeatMark';
import { RunningMark } from '../RunningMark';

interface Props {
  item: BoardItem;
  today: string;
  /** The board's categories, whose dot and name the meta line shows for the item's. */
  pick: CategoryPick;
  /** Opens its dialog (`CardDialog`). */
  onOpen: () => void;
  titleRef: (el: HTMLButtonElement | null) => void;
  /** The checkbox: today's row's tick. None off today's list, where a tick belongs to its own day. */
  tick?: { checked: boolean; onChange: (checked: boolean, el: HTMLInputElement) => void };
  /** The session running on it: the meta line starts with the day log's pill, which the title names. */
  running?: Session;
  /** Drag and drop; an item without it doesn't drag. */
  drag?: ItemDrag;
}

/**
 * What drag and drop (`Board`) gives an item: its node ref and transform, and the attributes and
 * listeners of what it is dragged by. Apart, since the card's button adds its own description to
 * dnd-kit's instructions.
 */
export interface ItemDrag {
  nodeRef: (el: HTMLElement | null) => void;
  style: CSSProperties;
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
}

/**
 * A task on the board: its tick, its number on today's list, its title, and a line with the timer
 * running on it, its category, the Repeats mark of a recurring row, a mark for a note, and the day
 * it was left open on. The title's button reaches over the whole card (styles.css): a click or
 * Enter opens the dialog, and it is what a mouse, a finger's hold or Space drags.
 */
export function BoardCardView({ item, today, pick, onOpen, titleRef, tick, running, drag }: Props) {
  const category = categoryOf(pick.categories, item.categoryUid);
  const markId = `running-${item.id}`;
  const noted = hasNote(item.note);
  return (
    <li ref={drag?.nodeRef} style={drag?.style} className={`board-card${item.column === 'done' ? ' is-done' : ''}`}>
      <div className="board-card-row">
        {tick && (
          // The label is the tick's touch area (styles.css); the box itself is 22 px.
          <label className="board-tick">
            <input
              type="checkbox"
              className="checkbox"
              checked={tick.checked}
              onChange={(e) => tick.onChange(e.target.checked, e.target)}
              aria-label={`${item.title} done`}
            />
          </label>
        )}
        {item.column === 'progress' && item.row && (
          <span className="board-card-num" aria-hidden="true">
            {item.row.position}
          </span>
        )}
        <button
          ref={titleRef}
          className="board-card-open"
          {...drag?.attributes}
          {...drag?.listeners}
          // dnd-kit's, for an item whose move is on its way: it still opens.
          aria-disabled={undefined}
          aria-haspopup="dialog"
          aria-describedby={[running && markId, drag?.attributes['aria-describedby']].filter(Boolean).join(' ') || undefined}
          onClick={onOpen}
          // Enter ends a keyboard drag, and a key still held from that (or from the title's Enter
          // in the dialog) repeats onto the card: only a fresh press opens it.
          onKeyDownCapture={(e) => {
            if (e.key === 'Enter' && e.repeat) e.preventDefault();
          }}
          // Space picks the card up and drops it on its keydown, and a button acts on Space's
          // keyup (Firefox), which would open the dialog.
          onKeyUp={
            drag?.listeners
              ? (e) => {
                  if (e.key === ' ') e.preventDefault();
                }
              : undefined
          }
        >
          <span className="board-card-title">{item.title}</span>
        </button>
      </div>
      {(running != null || category != null || item.recurring || noted || item.leftOpen != null) && (
        <p className="board-card-meta muted small">
          {running && <RunningMark paused={running.pausedAt != null} id={markId} />}
          {category && <CategoryTag category={category} />}
          {item.recurring && <RepeatMark />}
          {noted && (
            <span className="board-card-note" role="img" aria-label="Has a note">
              <Note filled />
            </span>
          )}
          {item.leftOpen && <span>Left open from {dayName(item.leftOpen, today, true)}</span>}
        </p>
      )}
    </li>
  );
}

/** A category's dot and name, on a card's meta line, in its dialog and on the card under the pointer. */
export function CategoryTag({ category }: { category: Category }) {
  return (
    <span className="board-card-category">
      <CategoryDot color={category.color} />
      {category.name}
    </span>
  );
}
