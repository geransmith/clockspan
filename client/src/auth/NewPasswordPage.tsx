import { useState, type SubmitEvent } from 'react';
import * as api from '../api';
import { NewPasswordFields } from '../components/NewPasswordFields';
import { NEW_PASSWORD, PASSWORD_MISMATCH } from '../lib/copy';
import type { AuthInfo, PublicUser } from '../types';

interface Props {
  user: PublicUser;
  /** Re-reads the auth state; once the flag is cleared the app opens. */
  onDone: () => Promise<AuthInfo | null>;
  onSignOut: () => Promise<void>;
}

/**
 * Between a sign-in on a temporary password and the app: the server answers nothing else
 * until the user has chosen their own (`requireOwnPassword`), so this is the only way in.
 */
export function NewPasswordPage({ user, onDone, onSignOut }: Props) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (next !== confirm) {
      setError(PASSWORD_MISMATCH);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(current, next);
      await onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gate">
      <form className="gate-card" onSubmit={(e) => void submit(e)}>
        <h1>{NEW_PASSWORD.title}</h1>
        <p className="muted">{NEW_PASSWORD.body}</p>
        {/* For password managers: the account this new password belongs to. */}
        <input type="text" autoComplete="username" value={user.username ?? ''} readOnly hidden />
        <label className="field">
          <span>Temporary password</span>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
            autoFocus
          />
        </label>
        <NewPasswordFields value={next} confirm={confirm} onValue={setNext} onConfirm={setConfirm} />
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary btn-lg" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Set password'}
        </button>
        <button className="btn btn-ghost" type="button" onClick={() => void onSignOut()}>
          Sign out
        </button>
      </form>
    </div>
  );
}
