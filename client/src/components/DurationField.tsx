import { useState, type FocusEvent, type KeyboardEvent } from 'react';

/**
 * Hours + minutes inputs that commit when focus leaves the pair or on Enter, so half-typed values
 * never save; a blank or non-numeric box puts the stored value back (type 0 for zero). `min` and
 * `max` are in minutes.
 */
export function DurationField({
  label,
  minutes,
  min,
  max,
  onCommit,
}: {
  label: string;
  minutes: number;
  min: number;
  max: number;
  onCommit: (m: number) => void;
}) {
  const [h, setH] = useState(String(Math.floor(minutes / 60)));
  const [m, setM] = useState(String(minutes % 60));
  // A new value from outside (save confirmed, reset) replaces the draft; React's
  // "adjust state while rendering" form, so it lands in the same render.
  const [seen, setSeen] = useState(minutes);
  if (minutes !== seen) {
    setSeen(minutes);
    setH(String(Math.floor(minutes / 60)));
    setM(String(minutes % 60));
  }
  // Moving from hours to minutes is still typing: saving there would store the new hours with
  // the old minutes (5h 0m → 4h 30m passes through 4h 0m), which can move an alarm's deadline
  // into the past for a moment and fire it.
  const onBlur = (e: FocusEvent<HTMLSpanElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    const hh = h.trim() === '' ? NaN : Number(h);
    const mm = m.trim() === '' ? NaN : Number(m);
    const total = Number.isFinite(hh) && Number.isFinite(mm) ? Math.max(min, Math.min(max, Math.round(hh * 60 + mm))) : minutes;
    if (total !== minutes) onCommit(total);
    else {
      setH(String(Math.floor(minutes / 60)));
      setM(String(minutes % 60));
    }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && e.currentTarget.blur();
  return (
    <div className="setting-row">
      <span>{label}</span>
      <span className="duration-inputs" onBlur={onBlur}>
        <input
          className="input input-num"
          inputMode="numeric"
          value={h}
          onChange={(e) => setH(e.target.value)}
          onKeyDown={onKey}
          aria-label={`${label} hours`}
        />
        <span className="muted">h</span>
        <input
          className="input input-num"
          inputMode="numeric"
          value={m}
          onChange={(e) => setM(e.target.value)}
          onKeyDown={onKey}
          aria-label={`${label} minutes`}
        />
        <span className="muted">m</span>
      </span>
    </div>
  );
}
