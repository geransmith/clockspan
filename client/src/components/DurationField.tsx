import { useState, type FocusEvent, type KeyboardEvent } from 'react';

/** A length in minutes as the hours and minutes boxes show it. */
const split = (minutes: number) => [String(Math.floor(minutes / 60)), String(minutes % 60)] as const;

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
  const [h, setH] = useState(split(minutes)[0]);
  const [m, setM] = useState(split(minutes)[1]);
  // A new value from outside (save confirmed, reset) replaces the draft; React's
  // "adjust state while rendering" form, so it lands in the same render.
  const [seen, setSeen] = useState(minutes);
  if (minutes !== seen) {
    setSeen(minutes);
    const [hh, mm] = split(minutes);
    setH(hh);
    setM(mm);
  }
  // Moving from hours to minutes is still typing: saving there would store the new hours with
  // the old minutes (5h 0m → 4h 30m passes through 4h 0m), which can move an alarm's deadline
  // into the past for a moment and fire it.
  const onBlur = (e: FocusEvent<HTMLSpanElement>) => {
    if (e.currentTarget.contains(e.relatedTarget)) return;
    const hh = h.trim() === '' ? NaN : Number(h);
    const mm = m.trim() === '' ? NaN : Number(m);
    const total = Number.isFinite(hh) && Number.isFinite(mm) ? Math.max(min, Math.min(max, Math.round(hh * 60 + mm))) : minutes;
    if (total !== minutes) onCommit(total);
    else {
      const [sh, sm] = split(minutes);
      setH(sh);
      setM(sm);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && e.currentTarget.blur();
  return (
    <div className="setting-row">
      <span>{label}</span>
      <span className="inline-controls" onBlur={onBlur}>
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
