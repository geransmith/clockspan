/** The settings tabs' building blocks: a titled section and its switch and number rows. */
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

export function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle-row">
      <span className="toggle-text">
        <span>{label}</span>
        {hint && <span className="muted small">{hint}</span>}
      </span>
      <input type="checkbox" role="switch" aria-checked={checked} className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
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

/** A number box that commits on blur or Enter, clamped to its bounds. */
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
    const n = Math.max(min, Math.min(max, Math.round(Number(v) || 0)));
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
