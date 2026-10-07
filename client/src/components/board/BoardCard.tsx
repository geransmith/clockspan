import { useRef, useState } from 'react';
import { LIMITS } from '../../../../shared/api.js';
import { moveTargets, type BoardItem, type ColumnId } from '../../lib/board';
import { dayName } from '../../lib/format';

export const COLUMN_NAMES: Record<ColumnId, string> = { later: 'Later', next: 'Next', progress: 'In progress', done: 'Done' };

interface Props {
  item: BoardItem;
  today: string;
  /** The editor is open; one at a time on the board. */
  open: boolean;
  onToggle: () => void;
  /** Closes the editor from inside it (Escape in the title box), with focus back on the title. */
  onClose: () => void;
  titleRef: (el: HTMLButtonElement | null) => void;
  /** The checkbox: the row's tick, or a Done card's untick. None for an earlier day's row. */
  tick?: { checked: boolean; onChange: (checked: boolean, el: HTMLInputElement) => void };
  onMove: (to: ColumnId, el: HTMLElement) => void;
  /** Renames it; without one the title shows as text (an earlier day's row). */
  onRename?: (title: string) => void;
  onDelete?: () => void;
  /** A recurring row's way off today's list. */
  onRemove?: () => void;
}

/**
 * A card or a row on the board: its tick, its number on today's list, its title (a button that
 * opens the editor) and a line saying when a later day's list holds it. The editor renames it,
 * moves it to another column (Move to, the way to move without dragging), and deletes it; a
 * planned item's offers Delete only, since that day's list decides it.
 */
export function BoardCardView({ item, today, open, onToggle, onClose, titleRef, tick, onMove, onRename, onDelete, onRemove }: Props) {
  const targets = moveTargets(item);
  const editorId = `editor-${item.id}`;
  return (
    <li className={`board-card${item.column === 'done' ? ' is-done' : ''}`}>
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
        <button ref={titleRef} className="board-card-open" aria-expanded={open} aria-controls={open ? editorId : undefined} onClick={onToggle}>
          <span className="board-card-title">{item.title}</span>
        </button>
      </div>
      {item.planned && <p className="board-card-meta muted small">Planned for {dayName(item.planned, today, true)}</p>}
      {open && (
        <div className="board-editor" id={editorId}>
          {onRename && !item.planned ? (
            <TitleField title={item.title} onRename={onRename} onClose={onClose} />
          ) : (
            <p className="board-editor-title">{item.title}</p>
          )}
          {item.planned ? (
            <p className="muted small">Change it on that day's sheet.</p>
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

/**
 * The title being edited: saved when focus leaves with it changed, or on Enter, which closes the
 * editor with the focus back on the title as Escape does; Escape puts the title back.
 */
function TitleField({ title, onRename, onClose }: { title: string; onRename: (title: string) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(title);
  const [seen, setSeen] = useState(title);
  // Enter and Escape move the focus to the title, and the blur that brings runs before the editor
  // has gone: it must know the edit already ended, saved or dropped.
  const ended = useRef(false);
  // A rename that landed, here or on another device, shows in the box.
  if (title !== seen) {
    setSeen(title);
    setDraft(title);
  }
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
