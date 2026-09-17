import { useEffect, useRef, useState } from 'react';
import { useSettings } from '../hooks/useSettings';
import { MAX_PRIORITIES, padPriorities, pickWarning, warnThreshold } from '../lib/priorities';
import type { Priority } from '../types';
import { Plus, X } from './Icons';

interface Props {
  date: string;
  priorities: Priority[];
  onChange: (priorities: Priority[]) => void;
}

/**
 * Starts with `priorityCount` rows and grows on demand. Text saves 400 ms after the last
 * keystroke; checkboxes, add and remove save immediately.
 */
export function Priorities({ date, priorities, onChange }: Props) {
  const { settings } = useSettings();
  const count = settings.priorityCount;
  const [local, setLocal] = useState(() => padPriorities(priorities, count));
  const [warning, setWarning] = useState<string | null>(null);
  const lastWarning = useRef<string | undefined>(undefined);
  const dirty = useRef(false);
  const timer = useRef<number | null>(null);
  const inputs = useRef(new Map<number, HTMLInputElement>());
  const focusNext = useRef<number | null>(null);

  // Adopt server state when the day changes or when we have no unsaved edits.
  useEffect(() => {
    if (!dirty.current) setLocal(padPriorities(priorities, count));
  }, [priorities, date, count]);
  useEffect(() => {
    dirty.current = false;
    setLocal(padPriorities(priorities, count));
    setWarning(null);
  }, [date]);
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
      // An empty row can't be done; clearing the text also clears the tick.
      return merged.text.trim() ? merged : { ...merged, done: false };
    });
    setLocal(next);
    dirty.current = true;
    if (timer.current) window.clearTimeout(timer.current);
    if (immediate) flush(next);
    else timer.current = window.setTimeout(() => flush(next), 400);
  };
  const addRow = (force = false) => {
    if (local.length >= MAX_PRIORITIES) return;
    if (!force && local.length >= warnThreshold(count)) {
      const w = pickWarning(Math.random, lastWarning.current);
      lastWarning.current = w;
      setWarning(w);
      return;
    }
    setWarning(null);
    const next = [...local, { position: local.length + 1, text: '', done: false }];
    focusNext.current = next.length;
    setLocal(next);
    flush(next);
  };
  const removeRow = (position: number) => {
    const next = local.filter((p) => p.position !== position).map((p, i) => ({ ...p, position: i + 1 }));
    setLocal(next);
    flush(next);
  };

  const done = local.filter((p) => p.done && p.text.trim()).length;
  const total = local.filter((p) => p.text.trim()).length;

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
              onChange={(e) => edit(p.position, { done: e.target.checked }, true)}
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
              maxLength={500}
            />
            {removable && (
              <button className="btn btn-icon priority-remove" onClick={() => removeRow(p.position)} aria-label={`Remove priority ${p.position}`} title="Remove">
                <X />
              </button>
            )}
          </div>
        );
      })}
      {warning && (
        <div className="notice notice--gentle" role="status">
          <span>{warning}</span>
          <span className="notice-actions">
            <button className="btn btn-ghost" onClick={() => addRow(true)}>
              Add anyway
            </button>
            <button className="btn btn-ghost" onClick={() => setWarning(null)}>
              Keep it short
            </button>
          </span>
        </div>
      )}
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
