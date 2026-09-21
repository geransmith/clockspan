import { useEffect, useRef, useState } from 'react';
import { useSettings } from '../hooks/useSettings';
import { WARNING_ACTIONS } from '../lib/copy';
import { MAX_PRIORITIES, newUid, padPriorities, pickWarning, warnThreshold, warningKind, type WarningKind } from '../lib/priorities';
import { LIMITS, type Priority } from '../types';
import { Burst, BURST_MS } from './Burst';
import { Check, Plus, X } from './Icons';

interface Props {
  priorities: Priority[];
  onChange: (priorities: Priority[]) => void;
}

/**
 * Starts with `priorityCount` rows and grows on demand. Text saves 400 ms after the last
 * keystroke; checkboxes, add and remove save immediately. Keyed by date in the sheet, so a
 * new day mounts fresh instead of carrying drafts over.
 */
export function Priorities({ priorities, onChange }: Props) {
  const { settings } = useSettings();
  const count = settings.priorityCount;
  const [local, setLocal] = useState(() => padPriorities(priorities, count));
  const [warning, setWarning] = useState<{ kind: WarningKind; text: string } | null>(null);
  const lastWarning = useRef<string | undefined>(undefined);
  const dirty = useRef(false);
  const timer = useRef<number | null>(null);
  const inputs = useRef(new Map<number, HTMLInputElement>());
  const focusNext = useRef<number | null>(null);
  // A tick gets a burst from its checkbox; the burst goes away on its own.
  const [burst, setBurst] = useState<{ seed: number; anchor: DOMRect } | null>(null);
  useEffect(() => {
    if (!burst) return;
    const id = window.setTimeout(() => setBurst(null), BURST_MS);
    return () => window.clearTimeout(id);
  }, [burst]);

  // Adopt server state whenever there are no unsaved edits.
  useEffect(() => {
    if (!dirty.current) setLocal(padPriorities(priorities, count));
  }, [priorities, count]);
  useEffect(() => {
    if (focusNext.current == null) return;
    inputs.current.get(focusNext.current)?.focus();
    focusNext.current = null;
  }, [local.length]);

  const flush = (next: Priority[]) => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    dirty.current = false;
    onChange(next);
  };
  const edit = (position: number, patch: Partial<Priority>, immediate = false) => {
    const next = local.map((p) => {
      if (p.position !== position) return p;
      const merged = { ...p, ...patch };
      // An empty row can't be done; clearing the text also clears the tick. The uid is
      // minted the first time a row gets text and survives a clear, so a session that
      // pointed at it still does.
      if (!merged.text.trim()) return { ...merged, done: false };
      return merged.uid ? merged : { ...merged, uid: newUid(), addedAt: Date.now() };
    });
    setLocal(next);
    dirty.current = true;
    if (timer.current) window.clearTimeout(timer.current);
    if (immediate) flush(next);
    else timer.current = window.setTimeout(() => flush(next), 400);
  };
  const doneRows = local.filter((p) => p.done && p.text.trim());
  const done = doneRows.length;
  const total = local.filter((p) => p.text.trim()).length;

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
    setLocal(next);
    flush(next);
  };
  const removeRow = (position: number) => {
    const next = local.filter((p) => p.position !== position).map((p, i) => ({ ...p, position: i + 1 }));
    setLocal(next);
    flush(next);
  };

  return (
    <div className="priorities">
      {local.map((p) => {
        const empty = !p.text.trim();
        const removable = p.position > count;
        return (
          <div key={p.position} className={`priority-row${p.done ? ' is-done' : ''}${removable ? ' priority-row--removable' : ''}`}>
            <span className="priority-num" aria-hidden="true">
              {p.position}
            </span>
            <input
              type="checkbox"
              className="checkbox"
              checked={p.done}
              disabled={empty}
              onChange={(e) => {
                if (e.target.checked && settings.celebrations) setBurst({ seed: Date.now(), anchor: e.target.getBoundingClientRect() });
                edit(p.position, { done: e.target.checked }, true);
              }}
              aria-label={`Priority ${p.position} done`}
              title={empty ? 'Write the priority first' : undefined}
            />
            <input
              ref={(el) => {
                if (el) inputs.current.set(p.position, el);
                else inputs.current.delete(p.position);
              }}
              className="input priority-input"
              value={p.text}
              placeholder={p.position === 1 ? 'The one thing that would make today a win' : `Priority ${p.position}`}
              onChange={(e) => edit(p.position, { text: e.target.value })}
              onBlur={() => dirty.current && flush(local)}
              maxLength={LIMITS.priorityText}
            />
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
      {warning && (
        <div className="notice notice--gentle" role="status">
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
