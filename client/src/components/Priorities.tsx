import { useEffect, useMemo, useRef, useState } from 'react';
import { useCelebration, type Moment } from '../hooks/useCelebration';
import { useDebouncedDraft } from '../hooks/useDebouncedDraft';
import { useSettings } from '../hooks/useSettings';
import { unlockAudio } from '../lib/alerts';
import { LEFT_OPEN, WARNING_ACTIONS } from '../lib/copy';
import { carryOver, editPriority, hasText, padPriorities, pickWarning, removePriority, warnThreshold, warningKind, type WarningKind } from '../lib/priorities';
import { MAX_PRIORITIES } from '../../../shared/settings.js';
import { LIMITS, type Priority } from '../types';
import { Burst } from './Burst';
import { Check, Plus, X } from './Icons';

interface Props {
  priorities: Priority[];
  onChange: (priorities: Priority[]) => void;
  /** What the last planned day left unticked (`from` names that day), offered while the list is empty. */
  leftOpen?: { from: string; rows: Priority[]; dismiss: () => void } | null;
}

/**
 * Starts with `priorityCount` rows and grows on demand. Text saves 400 ms after the last
 * keystroke; checkboxes, add and remove save immediately. Keyed by date in the sheet, so a
 * new day mounts fresh instead of carrying drafts over.
 */
export function Priorities({ priorities, onChange, leftOpen }: Props) {
  const { settings } = useSettings();
  const count = settings.priorityCount;
  const stored = useMemo(() => padPriorities(priorities, count), [priorities, count]);
  const { draft: local, edit: editList, flush } = useDebouncedDraft(stored, onChange, 400);
  const [warning, setWarning] = useState<{ kind: WarningKind; text: string } | null>(null);
  const lastWarning = useRef<string | undefined>(undefined);
  const inputs = useRef(new Map<number, HTMLTextAreaElement>());
  const focusNext = useRef<number | null>(null);
  // A tick gets a burst from its checkbox.
  const [ticked, setTicked] = useState<Moment | null>(null);
  const { anchor, burst } = useCelebration<HTMLInputElement>(ticked, 'priorityDone');

  useEffect(() => {
    if (focusNext.current == null) return;
    inputs.current.get(focusNext.current)?.focus();
    focusNext.current = null;
  }, [local.length]);

  const edit = (position: number, patch: Partial<Priority>, now = false) => {
    editList(
      local.map((p) => (p.position === position ? editPriority(p, patch, Date.now()) : p)),
      now,
    );
  };
  const doneRows = local.filter((p) => p.done && hasText(p));
  const done = doneRows.length;
  const total = local.filter(hasText).length;

  const addRow = (force = false) => {
    if (local.length >= MAX_PRIORITIES) return;
    if (!force && local.length >= warnThreshold(count)) {
      const kind = warningKind(done, total);
      const w = pickWarning(kind, Math.random, lastWarning.current);
      lastWarning.current = w;
      setWarning({ kind, text: w });
      return;
    }
    setWarning(null);
    const next = [...local, { position: local.length + 1, text: '', done: false, uid: null, addedAt: null }];
    focusNext.current = next.length;
    editList(next, true);
  };
  const bringOver = (rows: Priority[]) => editList(carryOver(rows, count), true);
  const removeRow = (position: number) => editList(removePriority(local, position), true);

  return (
    <div className="priorities">
      {leftOpen && total === 0 && (
        <div className="notice notice--gentle left-open">
          <div className="left-open-list">
            <strong>{LEFT_OPEN.title(leftOpen.from)}</strong>
            <ul>
              {leftOpen.rows.map((p) => (
                <li key={p.position}>{p.text}</li>
              ))}
            </ul>
          </div>
          <span className="notice-actions">
            <button className="btn" onClick={() => bringOver(leftOpen.rows)}>
              {LEFT_OPEN.add}
            </button>
            <button className="btn btn-ghost" onClick={leftOpen.dismiss}>
              {LEFT_OPEN.dismiss}
            </button>
          </span>
        </div>
      )}
      {local.map((p) => {
        const empty = !hasText(p);
        const removable = p.position > count;
        const placeholder = p.position === 1 ? 'The one thing that would make today a win' : `Priority ${p.position}`;
        return (
          <div key={p.position} className={`priority-row${p.done ? ' is-done' : ''}${removable ? ' priority-row--removable' : ''}`}>
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
                // One line of text: Enter adds no line break, and a pasted one becomes a space.
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.preventDefault();
                }}
                onChange={(e) => edit(p.position, { text: e.target.value.replace(/[\r\n]+/g, ' ') })}
                onBlur={flush}
                maxLength={LIMITS.priorityText}
              />
            </span>
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
              <button className="btn btn-ghost" onClick={() => setWarning(null)}>
                {WARNING_ACTIONS[warning.kind].keep}
              </button>
            </span>
          </div>
        )}
      </div>
      {burst && <Burst key={burst.seed} seed={burst.seed} anchor={burst.anchor} />}
      <div className="priorities-foot">
        {local.length < MAX_PRIORITIES ? (
          <button className="btn btn-ghost priority-add" onClick={() => addRow()}>
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
