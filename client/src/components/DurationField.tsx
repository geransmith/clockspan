import { useState, type KeyboardEvent } from 'react';

/** Hours + minutes inputs that commit on blur/Enter, so half-typed values never save. `min` and `max` are in minutes. */
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
  const commit = () => {
    const total = Math.max(min, Math.min(max, (Number(h) || 0) * 60 + (Number(m) || 0)));
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
      <span className="duration-inputs">
        <input
          className="input input-num"
          inputMode="numeric"
          value={h}
          onChange={(e) => setH(e.target.value)}
          onBlur={commit}
          onKeyDown={onKey}
          aria-label={`${label} hours`}
        />
        <span className="muted">h</span>
        <input
          className="input input-num"
          inputMode="numeric"
          value={m}
          onChange={(e) => setM(e.target.value)}
          onBlur={commit}
          onKeyDown={onKey}
          aria-label={`${label} minutes`}
        />
        <span className="muted">m</span>
      </span>
    </div>
  );
}
