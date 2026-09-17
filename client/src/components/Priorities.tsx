import { useEffect, useRef, useState } from 'react';
import type { Priority } from '../types';

interface Props {
  date: string;
  priorities: Priority[];
  onChange: (priorities: Priority[]) => void;
}

/** Three rows; text saves 400 ms after the last keystroke, checkboxes save immediately. */
export function Priorities({ date, priorities, onChange }: Props) {
  const [local, setLocal] = useState(priorities);
  const dirty = useRef(false);
  const timer = useRef<number | null>(null);

  // Adopt server state when the day changes or when we have no unsaved edits.
  useEffect(() => {
    if (!dirty.current) setLocal(priorities);
  }, [priorities, date]);
  useEffect(() => {
    dirty.current = false;
    setLocal(priorities);
  }, [date]);

  const flush = (next: Priority[]) => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    dirty.current = false;
    onChange(next);
  };
  const edit = (position: number, patch: Partial<Priority>, immediate = false) => {
    const next = local.map((p) => (p.position === position ? { ...p, ...patch } : p));
    setLocal(next);
    dirty.current = true;
    if (timer.current) window.clearTimeout(timer.current);
    if (immediate) flush(next);
    else timer.current = window.setTimeout(() => flush(next), 400);
  };

  const done = local.filter((p) => p.done && p.text.trim()).length;
  const total = local.filter((p) => p.text.trim()).length;

  return (
    <div className="priorities">
      {local.map((p) => (
        <label key={p.position} className={`priority-row${p.done ? ' is-done' : ''}`}>
          <span className="priority-num" aria-hidden="true">
            {p.position}
          </span>
          <input type="checkbox" className="checkbox" checked={p.done} onChange={(e) => edit(p.position, { done: e.target.checked }, true)} aria-label={`Priority ${p.position} done`} />
          <input
            className="input priority-input"
            value={p.text}
            placeholder={p.position === 1 ? 'The one thing that would make today a win' : `Priority ${p.position}`}
            onChange={(e) => edit(p.position, { text: e.target.value })}
            onBlur={() => dirty.current && flush(local)}
            maxLength={500}
          />
        </label>
      ))}
      {total > 0 && (
        <div className="priorities-summary muted">
          {done} of {total} done
        </div>
      )}
    </div>
  );
}
