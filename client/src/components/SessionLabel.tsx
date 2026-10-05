import { LIMITS } from '../../../shared/api.js';
import { UNTITLED_SESSION } from '../lib/copy';

/** A session's label, or a muted "Untitled session" when it has none. */
export function SessionLabel({ label }: { label: string }) {
  return label || <span className="muted">{UNTITLED_SESSION}</span>;
}

/**
 * The box a session's label is edited in. `onSave` (Enter) and `onDrop` (Escape) are called only
 * for those keys, so the caller knows the keyboard ended the edit; a blur is the caller's own.
 */
export function LabelInput({
  value,
  onChange,
  onSave,
  onDrop,
  onBlur,
  className,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onDrop: () => void;
  onBlur?: () => void;
  className: string;
  placeholder?: string;
}) {
  return (
    <input
      className={`input ${className}`}
      value={value}
      autoFocus
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      onKeyDown={(e) => {
        // An input method's Enter picks a candidate and its Escape drops one: neither ends the edit.
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Enter') onSave();
        if (e.key === 'Escape') onDrop();
      }}
      placeholder={placeholder}
      maxLength={LIMITS.sessionLabel}
      aria-label="Session label"
    />
  );
}
