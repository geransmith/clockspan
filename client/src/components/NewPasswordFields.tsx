import { useState, type InputHTMLAttributes } from 'react';
import { PASSWORD_LENGTH } from '../../../shared/api.js';
import { PASSWORD_MISMATCH } from '../lib/copy';

/** A new-password box with the server's length bounds, as `UsernameInput` is for usernames. */
export function NewPasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'autoComplete' | 'minLength' | 'maxLength' | 'required'>) {
  return (
    <input className="input" type="password" autoComplete="new-password" minLength={PASSWORD_LENGTH.min} maxLength={PASSWORD_LENGTH.max} required {...props} />
  );
}

/**
 * A new password typed twice, for the setup page, the temporary-password page and Settings →
 * Account, its values held by `useNewPassword`; the length bounds are the server's.
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
      <NewPasswordInput value={v} onChange={(e) => set(e.target.value)} />
    </label>
  );
  return (
    <>
      {field(label, value, onValue)}
      {field(`Confirm ${label.toLowerCase()}`, confirm, onConfirm)}
    </>
  );
}

/**
 * The two boxes of `NewPasswordFields` (spread `fields` on it). `checked()` is the password, and
 * throws `PASSWORD_MISMATCH` when the boxes differ, so the form's error line shows it before
 * anything is sent.
 */
export function useNewPassword() {
  const [value, onValue] = useState('');
  const [confirm, onConfirm] = useState('');
  return {
    fields: { value, confirm, onValue, onConfirm },
    checked: () => {
      if (value !== confirm) throw new Error(PASSWORD_MISMATCH);
      return value;
    },
    clear: () => {
      onValue('');
      onConfirm('');
    },
  };
}

/** For password managers: the account a new password belongs to, on a form with no username box. */
export function HiddenUsername({ username }: { username: string }) {
  return <input type="text" autoComplete="username" value={username} readOnly hidden />;
}
