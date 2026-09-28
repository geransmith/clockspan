import { PASSWORD_LENGTH } from '../types';

/**
 * A new password typed twice, for the setup page, the temporary-password page and Settings →
 * Account. Each form compares the two before it sends and shows `PASSWORD_MISMATCH` when they
 * differ; the length bounds are the server's.
 */
export function NewPasswordFields({
  label = 'New password',
  value,
  confirm,
  onValue,
  onConfirm,
}: {
  label?: string;
  value: string;
  confirm: string;
  onValue: (v: string) => void;
  onConfirm: (v: string) => void;
}) {
  const field = (text: string, v: string, set: (v: string) => void) => (
    <label className="field">
      <span>{text}</span>
      <input
        className="input"
        type="password"
        autoComplete="new-password"
        value={v}
        onChange={(e) => set(e.target.value)}
        minLength={PASSWORD_LENGTH.min}
        maxLength={PASSWORD_LENGTH.max}
        required
      />
    </label>
  );
  return (
    <>
      {field(label, value, onValue)}
      {field(`Confirm ${label.toLowerCase()}`, confirm, onConfirm)}
    </>
  );
}
