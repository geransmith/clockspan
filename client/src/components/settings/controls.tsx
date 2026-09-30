/** The settings tabs' building blocks: a titled section and its number rows (the switch is `../Toggle`). */
import { useState, type ReactNode } from 'react';

export function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <h3>{title}</h3>
      {hint && <p className="muted small">{hint}</p>}
      <div className="settings-fields">{children}</div>
    </section>
  );
}

/** A single whole number between `min` and `max` (minutes, rows, days); `unit` is the suffix, "min" by default. */
export function NumberField({
  label,
  value,
  min,
  max,
  unit = 'min',
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  unit?: string;
  disabled?: boolean;
  onCommit: (n: number) => void;
}) {
  return (
    <div className="setting-row">
      <span>{label}</span>
      <span className="duration-inputs">
        <NumberInput label={label} value={value} min={min} max={max} disabled={disabled} onCommit={onCommit} />
        <span className="muted">{unit}</span>
      </span>
    </div>
  );
}

/** A number box that commits on blur or Enter, clamped to its bounds; a blank or non-numeric box puts the stored value back (zero is typed as 0). */
export function NumberInput({
  label,
  value,
  min,
  max,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onCommit: (n: number) => void;
}) {
  const [v, setV] = useState(String(value));
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setV(String(value));
  }
  const commit = () => {
    const typed = v.trim() === '' ? NaN : Number(v);
    const n = Number.isFinite(typed) ? Math.max(min, Math.min(max, Math.round(typed))) : value;
    if (n !== value) onCommit(n);
    else setV(String(value));
  };
  return (
    <input
      className="input input-num"
      inputMode="numeric"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      aria-label={label}
      disabled={disabled}
    />
  );
}
