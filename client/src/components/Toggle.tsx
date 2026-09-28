/** A labelled on/off switch: a checkbox with the switch role, its label and an optional hint beside it. */
export function Toggle({
  label,
  hint,
  checked,
  onChange,
  className,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  /** Added to the row's own class, for a row placed outside the settings dialog. */
  className?: string;
}) {
  return (
    <label className={className ? `toggle-row ${className}` : 'toggle-row'}>
      <span className="toggle-text">
        <span>{label}</span>
        {hint && <span className="muted small">{hint}</span>}
      </span>
      <input type="checkbox" role="switch" aria-checked={checked} className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}
