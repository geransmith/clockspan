/** The settings tabs' building blocks: their props, a titled section and its number and select rows (the switch is `../Toggle`). */
import { useId, useState, type ReactNode } from 'react';
import type { SettingsPatch } from '../../api';
import type { Settings } from '../../types';

/** What the dialog hands every tab: the settings and a setter that takes only what changed. */
export interface TabProps {
  settings: Settings;
  set: (patch: SettingsPatch) => void;
}

export function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <h3>{title}</h3>
      {hint && <p className="muted small">{hint}</p>}
      <div className="settings-fields">{children}</div>
    </section>
  );
}

/** One choice from a fixed list of values, each shown by its label. */
export function SelectField<T extends string>({
  label,
  value,
  options,
  labels,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  labels: Record<T, string>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="setting-row">
      <span>{label}</span>
      <select className="input select" value={value} onChange={(e) => onChange(e.target.value as T)} aria-label={label}>
        {options.map((o) => (
          <option key={o} value={o}>
            {labels[o]}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * A single whole number between `min` and `max` (minutes, rows, days); `unit` is the suffix, "min"
 * by default. A `hint` sits under the label and describes the box.
 */
export function NumberField({
  label,
  value,
  min,
  max,
  unit = 'min',
  hint,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  unit?: string;
  hint?: string;
  disabled?: boolean;
  onCommit: (n: number) => void;
}) {
  const hintId = useId();
  return (
    <div className="setting-row">
      {hint ? (
        <span className="toggle-text">
          <span>{label}</span>
          <span id={hintId} className="muted small">
            {hint}
          </span>
        </span>
      ) : (
        <span>{label}</span>
      )}
      <span className="inline-controls">
        <NumberInput label={label} value={value} min={min} max={max} disabled={disabled} describedBy={hint ? hintId : undefined} onCommit={onCommit} />
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
  describedBy,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  /** The id of a hint that describes the box. */
  describedBy?: string;
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
      aria-describedby={describedBy}
      disabled={disabled}
    />
  );
}
