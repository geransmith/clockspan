import { Fragment, useId, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useCelebration, type Moment } from '../hooks/useCelebration';
import { useDebouncedDraft } from '../hooks/useDebouncedDraft';
import { useSettings } from '../hooks/useSettings';
import { unlockAudio } from '../lib/alerts';
import type { CategoryPick } from '../lib/board';
import { EMPTIED_ROW, LEFT_OPEN, WARNING_ACTIONS } from '../lib/copy';
import { formatDuration } from '../lib/format';
import { planNext, type PrioritySeed } from '../lib/plan';
import { editPriority, emptyRow, nudgeFor, padPriorities, pickWarning, removePriority, type WarningKind } from '../lib/priorities';
import { loggedByUid } from '../lib/retro';
import { hasText, isFree } from '../../../shared/priorities.js';
import { LIMITS } from '../../../shared/api.js';
import { MAX_PRIORITIES } from '../../../shared/settings.js';
import type { Priority, Session } from '../types';
import { Burst } from './Burst';
import { CategoryChip } from './CategoryChip';
import { Check, Plus, X } from './Icons';

interface Props {
  priorities: Priority[];
  /** The day's sessions: a cleared row with focus logged on it says the time stays with it. */
  sessions: Session[];
  /** `base`: the rows the edits were made on, the list the card last sent or last took up from `priorities`. */
  onChange: (priorities: Priority[], base: Priority[]) => void;
  /** The category chip's data: each row with text gets a chip. Null (the board off) shows none. */
  pick?: CategoryPick | null;
  /**
   * What the last planned day left unticked (`from` names that day), offered while the list is
   * empty: its rows as seeds, which the board may have retitled from their cards.
   */
  leftOpen?: { from: string; rows: PrioritySeed[]; dismiss: () => void } | null;
}

/**
 * Starts with `priorityCount` rows and grows on demand. Text saves 400 ms after the last
 * keystroke; checkboxes, add and remove save immediately. Keyed by date in the sheet, so a
 * new day mounts fresh instead of carrying drafts over.
 */
export function Priorities({ priorities, sessions, onChange, pick = null, leftOpen }: Props) {
  const { settings } = useSettings();
  const count = settings.priorityCount;
  const stored = useMemo(() => padPriorities(priorities, count), [priorities, count]);
  // Let go once sent: a list held after a failed save would stop the card following the stored
  // list (a row the timer's "Also add to today's priorities" or another device added, a tick
  // made elsewhere) until a later save went through. A failed row goes back to the stored copy,
  // with the banner.
  const sendList = (list: Priority[], base: Priority[]) => {
    onChange(list, base);
    return true;
  };
  const { draft: local, edit: editList, flush } = useDebouncedDraft(stored, sendList, 400);
  const [warning, setWarning] = useState<{ kind: WarningKind; text: string } | null>(null);
  const lastWarning = useRef<string | undefined>(undefined);
  const inputs = useRef(new Map<number, HTMLTextAreaElement>());
  // Where focus goes when the button that had it is taken away, so a keyboard user isn't sent back to the page's top.
  const addButton = useRef<HTMLButtonElement>(null);
  // A tick gets a burst from its checkbox.
  const [ticked, setTicked] = useState<Moment | null>(null);
  const { anchor, burst } = useCelebration<HTMLInputElement>(ticked, 'priorityDone');
  const logged = useMemo(() => loggedByUid(sessions), [sessions]);
  const noteId = useId();

  const edit = (position: number, patch: Partial<Priority>, now = false) => {
    editList(
      local.map((p) => (p.position === position ? editPriority(p, patch, Date.now()) : p)),
      now,
    );
  };
  const doneRows = local.filter((p) => p.done);
  const done = doneRows.length;
  const total = local.filter(hasText).length;

  const addRow = (force = false) => {
    // A row never written in is where a new priority goes, with no nudge: the nudge is about a
    // written list. A cleared row is passed, since it keeps its uid and the time logged on it.
    // Focusing the row inside the tap is what lets iOS raise the keyboard.
    const free = local.find(isFree);
    if (free) {
      setWarning(null);
      inputs.current.get(free.position)?.focus();
      return;
    }
    if (local.length >= MAX_PRIORITIES) return;
    const kind = force ? null : nudgeFor(local, count);
    if (kind) {
      const w = pickWarning(kind, lastWarning.current);
      lastWarning.current = w;
      setWarning({ kind, text: w });
      return;
    }
    setWarning(null);
    const next = [...local, emptyRow(local.length + 1)];
    // Rendered at once, so the new row is there to take focus inside the same tap.
    flushSync(() => editList(next, true));
    inputs.current.get(next.length)?.focus();
  };
  // The rows are new to today (fresh uids, `addedAt` now), so the retro counts them as planned
  // unless a session ran first; each carries its card, recurring priority and category, so it
  // is the same task. A text that appears twice comes over once. A cleared row stays, ahead of
  // them, with the time logged on it, unless it holds the card or recurring priority of a row
  // brought over: that row takes it back, keeping its uid and addedAt. The offer shows only
  // while no row has text, so the first row with text is the first it filled, and focus goes
  // there.
  const bringOver = (rows: PrioritySeed[]) => {
    const { rows: next } = planNext(local, rows);
    flushSync(() => editList(padPriorities(next, count), true));
    const first = next.find(hasText);
    if (first) inputs.current.get(first.position)?.focus();
  };
  // Focus goes where Add priority would put a new priority, never into a cleared row, which is still its old item.
  const dismissLeftOpen = (dismiss: () => void) => {
    dismiss();
    const free = local.find(isFree);
    if (free) inputs.current.get(free.position)?.focus();
    else addButton.current?.focus();
  };
  const removeRow = (position: number) => {
    // Removing a row before the last moves the next row's X under focus; the last row takes its X with it.
    flushSync(() => editList(removePriority(local, position), true));
    if (position === local.length) addButton.current?.focus();
  };
  const keepList = () => {
    setWarning(null);
    addButton.current?.focus();
  };

  return (
    <div className="priorities">
      {leftOpen && total === 0 && (
        <div className="notice notice--gentle left-open">
          <div className="left-open-list">
            <strong>{LEFT_OPEN.title(leftOpen.from)}</strong>
            <ul>
              {leftOpen.rows.map((p, i) => (
                <li key={i}>{p.text}</li>
              ))}
            </ul>
          </div>
          <span className="notice-actions">
            <button className="btn" onClick={() => bringOver(leftOpen.rows)}>
              {LEFT_OPEN.add}
            </button>
            <button className="btn btn-ghost" onClick={() => dismissLeftOpen(leftOpen.dismiss)}>
              {LEFT_OPEN.dismiss}
            </button>
          </span>
        </div>
      )}
      {local.map((p) => {
        const empty = !hasText(p);
        const removable = p.position > count;
        // A written row only: an empty one has nothing to file yet, and keeps the plain grid.
        const chip = pick != null && !empty;
        const placeholder = p.position === 1 ? 'The one thing to get done' : `Priority ${p.position}`;
        // A cleared row is still the same item: the focus logged on it stays, and a new priority
        // goes past it. The draft's row decides, so the first key typed takes the note away.
        const held = empty && p.uid != null ? (logged.get(p.uid) ?? 0) : 0;
        const heldId = `${noteId}-held-${p.position}`;
        return (
          <Fragment key={p.position}>
            <div className={`priority-row${p.done ? ' is-done' : ''}${removable ? ' priority-row--removable' : ''}${chip ? ' priority-row--end' : ''}`}>
              <span className="priority-num" aria-hidden="true">
                {p.position}
              </span>
              {/* The label is the tick's touch area (styles.css); the box itself is 22 px. */}
              <label className="priority-tick">
                <input
                  type="checkbox"
                  className="checkbox"
                  checked={p.done}
                  disabled={empty}
                  onChange={(e) => {
                    if (e.target.checked) {
                      // The sound plays once the tick has rendered; iOS only allows that after a tap unlocked it.
                      unlockAudio();
                      anchor.current = e.target;
                      setTicked({});
                    }
                    edit(p.position, { done: e.target.checked }, true);
                  }}
                  aria-label={`Priority ${p.position} done`}
                  title={empty ? 'Write the priority first' : undefined}
                />
              </label>
              {/* A textarea so a long priority wraps on a phone; the wrapper's copy of the text sets its height. */}
              <span className="grow-field" data-value={p.text || placeholder}>
                <textarea
                  ref={(el) => {
                    if (el) inputs.current.set(p.position, el);
                    else inputs.current.delete(p.position);
                  }}
                  className="input priority-input"
                  rows={1}
                  value={p.text}
                  placeholder={placeholder}
                  aria-label={`Priority ${p.position}`}
                  aria-describedby={held > 0 ? heldId : undefined}
                  // One line of text: Enter adds no line break, and a pasted one becomes a space.
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.preventDefault();
                  }}
                  onChange={(e) => edit(p.position, { text: e.target.value.replace(/[\r\n]+/g, ' ') })}
                  onBlur={() => void flush()}
                  maxLength={LIMITS.priorityText}
                />
              </span>
              {chip && (
                <span className="priority-end">
                  {/* A pick saves at once, as a tick does. Keyed by the row, since the rows are by
                      position: a row another device's change moves here gets a chip of its own,
                      closed, so a list left open never picks for it. */}
                  <CategoryChip
                    key={p.uid}
                    value={p.categoryUid}
                    onChange={(categoryUid) => edit(p.position, { categoryUid }, true)}
                    pick={pick}
                    label={`Category for priority ${p.position}`}
                  />
                </span>
              )}
              {removable && (
                <button
                  className="btn btn-icon priority-remove"
                  onClick={() => removeRow(p.position)}
                  aria-label={`Remove priority ${p.position}`}
                  title="Remove"
                >
                  <X />
                </button>
              )}
            </div>
            {held > 0 && (
              <p className="muted small priority-held" id={heldId}>
                {/* Whole minutes round down, so under one the line names no amount rather than "0m". */}
                {EMPTIED_ROW(held >= 60 ? formatDuration(held) : null)}
              </p>
            )}
          </Fragment>
        );
      })}
      {/* Always there, so the warning is heard when it arrives (see styles.css for its gap). */}
      <div className="priorities-notice" role="status">
        {warning && (
          <div className="notice notice--gentle">
            {warning.kind !== 'fresh' && (
              <div className="notice-done">
                <strong>
                  {done} of {total} done
                </strong>
                <ul>
                  {doneRows.map((p) => (
                    <li key={p.position}>
                      <Check />
                      <span>{p.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <span>{warning.text}</span>
            <span className="notice-actions">
              <button className="btn btn-ghost" onClick={() => addRow(true)}>
                {WARNING_ACTIONS[warning.kind].add}
              </button>
              <button className="btn btn-ghost" onClick={keepList}>
                {WARNING_ACTIONS[warning.kind].keep}
              </button>
            </span>
          </div>
        )}
      </div>
      <Burst at={burst} />
      <div className="priorities-foot">
        {local.length < MAX_PRIORITIES ? (
          <button ref={addButton} className="btn btn-ghost priority-add" onClick={() => addRow()}>
            <Plus />
            Add priority
          </button>
        ) : (
          <span />
        )}
        {total > 0 && (
          <span className="priorities-summary muted">
            {done} of {total} done
          </span>
        )}
      </div>
    </div>
  );
}
