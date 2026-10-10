import { useState } from 'react';
import * as api from '../api';
import { HiddenUsername, NewPasswordFields } from '../components/NewPasswordFields';
import { useSubmit } from '../hooks/useSubmit';
import { NEW_PASSWORD, PASSWORD_MISMATCH, SIGN_OUT_FAILED } from '../lib/copy';
import type { AuthInfo, PublicUser } from '../types';
import { ErrorLine } from '../components/ErrorLine';

interface Props {
  user: PublicUser;
  /** Re-reads the auth state; once the flag is cleared the app opens. */
  onDone: () => Promise<AuthInfo | null>;
  /** Resolves false when the session is still here. */
  onSignOut: () => Promise<boolean>;
}

/**
 * Between a sign-in on a temporary password and the app: the server answers nothing else
 * until the user has chosen their own (`requireOwnPassword`), so this is the only way in.
 */
export function NewPasswordPage({ user, onDone, onSignOut }: Props) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const { busy, error, setError, onSubmit } = useSubmit();

  const submit = onSubmit(async () => {
    if (next !== confirm) throw new Error(PASSWORD_MISMATCH);
    await api.changePassword(current, next);
    await onDone();
  });

  return (
    <div className="gate">
      <form className="gate-card" onSubmit={submit}>
        <h1>{NEW_PASSWORD.title}</h1>
        <p className="muted">{NEW_PASSWORD.body}</p>
        <HiddenUsername username={user.username ?? ''} />
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
        <ErrorLine error={error} />
        <button className="btn btn-primary btn-lg" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Set Password'}
        </button>
        <button
          className="btn btn-ghost"
          type="button"
          onClick={() =>
            void onSignOut().then((ok) => {
              if (!ok) setError(SIGN_OUT_FAILED);
            })
          }
        >
          Sign Out
        </button>
      </form>
    </div>
  );
}
