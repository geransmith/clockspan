import { useRef } from 'react';
import { LIMITS } from '../../../../shared/api.js';
import { hasNote } from '../../../../shared/text.js';
import { useFollowedDraft } from '../../hooks/useFollowedDraft';
import { useModalDialog } from '../../hooks/useModalDialog';
import { categoryOf, COLUMN_NAMES, moveTargets, type BoardItem, type CategoryPick, type ColumnId } from '../../lib/board';
import { WEEKDAYS } from '../../lib/recurring';
import { CategoryChip } from '../CategoryChip';
import { X } from '../Icons';
import { NoteField } from '../Note';
import { TimerLengths } from '../TimerLengths';
import { CategoryTag } from './BoardCard';

interface Props {
  item: BoardItem;
  today: string;
  /** The board's categories, for the chip, or the tag where the board can't file the task. */
  pick: CategoryPick;
  /** Escape, the ×, a press outside and Enter in the title: closes it with the focus on the card. */
  onClose: () => void;
  onMove: (to: ColumnId, el: HTMLElement) => void;
  /** Renames it; without one the title shows as text (an earlier day's row of a recurring priority that stopped repeating). */
  onRename?: (title: string) => void;
  /** Sets its category; without one the category shows as text, as the title does. */
  onCategory?: (uid: string | null) => void;
  /** Saves its note, resolving to whether it saved; without one the note shows as text, as the title does. */
  onNote?: (note: string, base: string) => Promise<boolean>;
  /** The note a save failed for as the dialog last closed: the box starts from it. */
  keptNote?: string;
  onDelete?: () => void;
  /** A recurring row's way off today's list. */
  onRemove?: () => void;
  /** The line under the title: where a task done earlier is unticked. */
  hint?: string;
  /** The timer card's length buttons; none where no timer can start on it (`Board`). */
  start?: { disabled: boolean; onStart: (minutes: number) => void };
  /**
   * The task's weekdays, each pressed to set or clear it (none on a one-off, whose first day makes
   * it a recurring priority), and a recurring priority's Stop Repeating; none where the server
   * can't change the task.
   */
  repeat?: { days: readonly number[]; onDay: (day: number, on: boolean) => void; onStop?: () => void };
}

/**
 * A board item's details, opened by its card: the title to rename it, its category and note, the
 * days it repeats on, Start timer, Move to (the way to move without dragging) and Delete, or Remove
 * from today for a recurring row. `Board` renders one, outside the columns, and closes it before a
 * move, a start or a delete runs (`closeCard`). A bottom sheet on a phone (`.dialog`). Each control
 * sits on a row of its own, a label and its buttons, so another can join them.
 */
export function CardDialog({ item, today, pick, onClose, onMove, onRename, onCategory, onNote, keptNote, onDelete, onRemove, hint, start, repeat }: Props) {
  const dialog = useModalDialog(onClose);
  const targets = moveTargets(item, today);
  const category = categoryOf(pick.categories, item.categoryUid);
  const id = `card-${item.id}`;
  return (
    <dialog {...dialog} className="dialog card-dialog" aria-label={item.title}>
      <div className="dialog-inner">
        <header className="dialog-head">
          {onRename ? <TitleField title={item.title} onRename={onRename} onClose={onClose} /> : <h2>{item.title}</h2>}
          <button className="btn btn-icon" aria-label="Close" onClick={onClose}>
            <X />
          </button>
        </header>
        <div className="dialog-body">
          {hint && <p className="muted small">{hint}</p>}
          {onCategory ? (
            <div className="card-dialog-category">
              <CategoryChip value={item.categoryUid} onChange={onCategory} pick={pick} label={`Category for ${item.title}`} />
            </div>
          ) : (
            category && (
              <p>
                <CategoryTag category={category} />
              </p>
            )
          )}
          {(onNote || hasNote(item.note)) && <NoteField id={`${id}-note`} of={item.title} note={item.note} kept={keptNote} open onSave={onNote} ms={800} />}
          {/* In the same place on a one-off and a recurring priority, so the day pressed keeps the focus as the task starts repeating. */}
          {repeat && <RepeatDays id={`${id}-repeat`} {...repeat} />}
          {start && (
            <div className="board-start" role="group" aria-labelledby={`${id}-start`}>
              <span id={`${id}-start`} className="muted small">
                Start timer
              </span>
              <TimerLengths onStart={start.onStart} disabled={start.disabled} />
            </div>
          )}
          {targets.length > 0 && (
            // Buttons, not a select: a select's arrow keys and typed letters change it, which moved the card.
            <div className="board-move" role="group" aria-labelledby={`${id}-move`}>
              <span id={`${id}-move`} className="muted small">
                Move to
              </span>
              <div className="board-move-targets">
                {targets.map((c) => (
                  <button key={c} className="btn" onClick={(e) => onMove(c, e.currentTarget)}>
                    {COLUMN_NAMES[c]}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        {(onRemove ?? onDelete) && (
          <footer className="dialog-foot">
            {onRemove && (
              <button className="btn btn-ghost" onClick={onRemove}>
                Remove From Today
              </button>
            )}
            {onDelete && (
              <button className="btn btn-ghost btn-danger-text" onClick={onDelete}>
                Delete
              </button>
            )}
          </footer>
        )}
      </div>
    </dialog>
  );
}

/**
 * A task's seven days, each a button pressed while it is on. The last day on stays on, and stays
 * focusable, so a recurring priority is always offered on some day; Stop Repeating ends it.
 */
function RepeatDays({ id, days, onDay, onStop }: { id: string } & NonNullable<Props['repeat']>) {
  return (
    <div className="board-repeat" role="group" aria-labelledby={id}>
      <span id={id} className="muted small">
        Repeat
      </span>
      <div className="weekdays">
        {WEEKDAYS.map(({ day, letter, name }) => {
          const on = days.includes(day);
          const last = on && days.length === 1;
          return (
            <button
              key={day}
              type="button"
              className="chip"
              onClick={() => {
                if (!last) onDay(day, !on);
              }}
              aria-pressed={on}
              aria-disabled={last || undefined}
              aria-label={name}
            >
              {letter}
            </button>
          );
        })}
      </div>
      {onStop && (
        <button className="btn btn-ghost" onClick={onStop}>
          Stop Repeating
        </button>
      )}
    </div>
  );
}

/**
 * The title being edited: saved when focus leaves with it changed, or on Enter, which closes the
 * dialog; Escape drops the edit, and the dialog's own Escape closes it.
 */
function TitleField({ title, onRename, onClose }: { title: string; onRename: (title: string) => void; onClose: () => void }) {
  const [draft, setDraft] = useFollowedDraft(title);
  // Closing blurs the box before the dialog goes (`closeCard`): that blur must know the edit
  // already ended, saved or dropped.
  const ended = useRef(false);
  const commit = () => {
    if (ended.current) return;
    const next = draft.trim();
    if (next && next !== title) onRename(next);
    else setDraft(title);
  };
  return (
    <input
      className="input"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        // An input method's Enter picks a candidate and its Escape drops one: neither ends the edit.
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Escape') ended.current = true;
        else if (e.key === 'Enter') {
          // The focus goes to the card inside this keydown, and the keypress that follows would
          // press it, opening the dialog again.
          e.preventDefault();
          commit();
          ended.current = true;
          onClose();
        }
      }}
      maxLength={LIMITS.priorityText}
      aria-label="Title"
    />
  );
}
