import { useId } from 'react';

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
  const id = useId();
  // The row is a <label> so a tap anywhere on it flips the switch, but that would make the
  // whole hint part of the switch's name; the label names it and the hint describes it.
  return (
    <label className={className ? `toggle-row ${className}` : 'toggle-row'}>
      <span className="toggle-text">
        <span id={`${id}-label`}>{label}</span>
        {hint && (
          <span id={`${id}-hint`} className="muted small">
            {hint}
          </span>
        )}
      </span>
      <input
        type="checkbox"
        role="switch"
        // Redundant with `checked` on a native checkbox, but oxlint's jsx-a11y rule asks for it on a switch.
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}
