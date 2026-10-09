import { useRef, useState, type CSSProperties } from 'react';
import { LIMITS } from '../../../../shared/api.js';
import { hasNote } from '../../../../shared/text.js';
import { useFollowedDraft } from '../../hooks/useFollowedDraft';
import { categoryOf, COLUMN_NAMES, moveTargets, type BoardItem, type CategoryPick, type ColumnId } from '../../lib/board';
import { BOARD } from '../../lib/copy';
import { dayName } from '../../lib/format';
import type { Category, Session } from '../../types';
import { CategoryChip } from '../CategoryChip';
import { CategoryDot } from '../CategoryDot';
import { Grip } from '../Icons';
import { NoteField, NoteToggle } from '../Note';
import { RepeatMark } from '../RepeatMark';
import { RunningMark } from '../RunningMark';
import { TimerLengths } from '../TimerLengths';

interface Props {
  item: BoardItem;
  today: string;
  /** The editor is open; one at a time on the board. */
  open: boolean;
  onToggle: () => void;
  /** Closes the editor from inside it (Escape in the title box), with focus back on the title. */
  onClose: () => void;
  titleRef: (el: HTMLButtonElement | null) => void;
  /** The checkbox: today's row's tick. None off today's list, where a tick belongs to its own day. */
  tick?: { checked: boolean; onChange: (checked: boolean, el: HTMLInputElement) => void };
  onMove: (to: ColumnId, el: HTMLElement) => void;
  /** Renames it; without one the title shows as text (an earlier day's row of a recurring priority removed in Settings). */
  onRename?: (title: string) => void;
  /** The board's categories, whose dot and name the meta line shows for the item's, and with `onCategory` the editor's chip. */
  pick: CategoryPick;
  /** Sets its category; none where the board doesn't (an earlier day's row of a recurring priority removed in Settings). */
  onCategory?: (uid: string | null) => void;
  /** Saves its note, resolving to whether it saved; without one the note shows as text, as the title does. */
  onNote?: (note: string) => Promise<boolean>;
  onDelete?: () => void;
  /** A recurring row's way off today's list. */
  onRemove?: () => void;
  /** The line under the title in the editor: where a task done earlier is unticked. */
  hint?: string;
  /** The editor's Start timer, the timer card's length buttons; none where no timer can start on it (`Board`). */
  start?: { disabled: boolean; onStart: (minutes: number) => void };
  /** The session running on it: the meta line starts with the day log's pill, which the title names. */
  running?: Session;
  /** Drag and drop; an item without it has no grip. */
  drag?: ItemDrag;
}

/** What drag and drop (`Board`) gives an item: its node ref and transform, and its grip's listeners and attributes. */
export interface ItemDrag {
  nodeRef: (el: HTMLElement | null) => void;
  style: CSSProperties;
  handleProps: Record<string, unknown>;
}

/**
 * A task on the board: its tick, its number on today's list, its title (a button that opens the
 * editor) and its note button, and a line with the timer running on it, its category, the Repeats
 * mark of a recurring row, and the day a later list holds it or it was left open on. The note
 * opens under that, apart from the editor, and saves 800 ms after the last key. The editor renames
 * it, sets its category, starts the focus timer on it, moves it to another column (Move to, the
 * way to move without dragging), and deletes it; a planned item's offers no Move to, since that
 * day's list decides where it shows.
 */
export function BoardCardView({
  item,
  today,
  open,
  onToggle,
  onClose,
  titleRef,
  tick,
  onMove,
  onRename,
  pick,
  onCategory,
  onNote,
  onDelete,
  onRemove,
  hint,
  start,
  running,
  drag,
}: Props) {
  const targets = moveTargets(item, today);
  const category = categoryOf(pick.categories, item.categoryUid);
  const editorId = `editor-${item.id}`;
  const markId = `running-${item.id}`;
  const noteBox = `note-${item.id}`;
  // Closed on each load.
  const [noteOpen, setNoteOpen] = useState(false);
  const noted = onNote != null || hasNote(item.note);
  return (
    <li ref={drag?.nodeRef} style={drag?.style} className={`board-card${item.column === 'done' ? ' is-done' : ''}`}>
      <div className="board-card-row">
        {drag && (
          // The drag handle, and with Space the keyboard's: dnd-kit's attributes give its role and instructions.
          <button className="board-grip" {...drag.handleProps} aria-label={`Drag to move ${item.title}`} title="Drag to move">
            <Grip />
          </button>
        )}
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
          aria-expanded={open}
          aria-controls={open ? editorId : undefined}
          aria-describedby={running ? markId : undefined}
          onClick={onToggle}
        >
          <span className="board-card-title">{item.title}</span>
        </button>
        {noted && <NoteToggle boxId={noteBox} of={item.title} note={item.note} open={noteOpen} onToggle={setNoteOpen} />}
      </div>
      {(running != null || category != null || item.planned != null || item.leftOpen != null || item.recurring) && (
        <p className="board-card-meta muted small">
          {running && <RunningMark paused={running.pausedAt != null} id={markId} />}
          {category && <CategoryTag category={category} />}
          {item.recurring && <RepeatMark />}
          {item.planned && <span>Planned for {dayName(item.planned, today, true)}</span>}
          {item.leftOpen && <span>Left open from {dayName(item.leftOpen, today, true)}</span>}
        </p>
      )}
      {noted && <NoteField id={noteBox} of={item.title} note={item.note} open={noteOpen} onClose={() => setNoteOpen(false)} onSave={onNote} ms={800} />}
      {open && (
        <div className="board-editor" id={editorId}>
          {onRename ? <TitleField title={item.title} onRename={onRename} onClose={onClose} /> : <p className="board-editor-title">{item.title}</p>}
          {hint && <p className="muted small">{hint}</p>}
          {onCategory && (
            <div className="board-editor-category">
              <CategoryChip value={item.categoryUid} onChange={onCategory} pick={pick} label={`Category for ${item.title}`} />
            </div>
          )}
          {start && (
            <div className="board-start" role="group" aria-labelledby={`${editorId}-start`}>
              <span id={`${editorId}-start`} className="muted small">
                Start timer
              </span>
              <TimerLengths onStart={start.onStart} disabled={start.disabled} />
            </div>
          )}
          {item.planned ? (
            <p className="muted small">{BOARD.plannedSheet}</p>
          ) : (
            targets.length > 0 && (
              <label className="board-move">
                <span className="muted small">Move to</span>
                <select
                  className="input select board-move-select"
                  // Named outright: a select's own text is its picked option, which Chrome can take for its name.
                  aria-label="Move to"
                  value=""
                  onChange={(e) => {
                    const to = targets.find((c) => c === e.target.value);
                    if (to) onMove(to, e.target);
                  }}
                >
                  <option value="" disabled>
                    Pick a column
                  </option>
                  {targets.map((c) => (
                    <option key={c} value={c}>
                      {COLUMN_NAMES[c]}
                    </option>
                  ))}
                </select>
              </label>
            )
          )}
          {(onRemove ?? onDelete) && (
            <div className="board-editor-actions">
              {onRemove && (
                <button className="btn btn-ghost" onClick={onRemove}>
                  Remove from today
                </button>
              )}
              {onDelete && (
                <button className="btn btn-ghost btn-danger-text" onClick={onDelete}>
                  Delete
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** A category's dot and name, on a card's meta line and the card under the pointer. */
export function CategoryTag({ category }: { category: Category }) {
  return (
    <span className="board-card-category">
      <CategoryDot color={category.color} />
      {category.name}
    </span>
  );
}

/**
 * The title being edited: saved when focus leaves with it changed, or on Enter, which closes the
 * editor with the focus back on the title as Escape does; Escape puts the title back.
 */
function TitleField({ title, onRename, onClose }: { title: string; onRename: (title: string) => void; onClose: () => void }) {
  const [draft, setDraft] = useFollowedDraft(title);
  // Enter and Escape move the focus to the title, and the blur that brings runs before the editor
  // has gone: it must know the edit already ended, saved or dropped.
  const ended = useRef(false);
  const commit = () => {
    if (ended.current) return;
    const next = draft.trim();
    if (next && next !== title) onRename(next);
    else setDraft(title);
  };
  return (
    <input
      className="input board-title-input"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        // An input method's Enter picks a candidate and its Escape drops one: neither ends the edit.
        if (e.nativeEvent.isComposing) return;
        if (e.key !== 'Enter' && e.key !== 'Escape') return;
        if (e.key === 'Enter') commit();
        ended.current = true;
        onClose();
      }}
      maxLength={LIMITS.priorityText}
      aria-label="Title"
    />
  );
}
