import { useState } from 'react';
import * as api from '../api';
import { NewPasswordFields } from '../components/NewPasswordFields';
import { useSubmit } from '../hooks/useSubmit';
import { PASSWORD_MISMATCH } from '../lib/copy';
import type { AuthInfo } from '../types';

interface Props {
  onDone: () => Promise<AuthInfo | null>;
  /** See `LoginPage`. */
  hint?: string | null;
}

export function SetupPage({ onDone, hint }: Props) {
  const [code, setCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const { busy, error, onSubmit } = useSubmit();

  const submit = onSubmit(async () => {
    if (password !== confirm) throw new Error(PASSWORD_MISMATCH);
    await api.setup(code, username.trim(), password);
    await onDone();
  });

  return (
    <div className="gate">
      <form className="gate-card" onSubmit={submit}>
        <h1>Welcome to Clockspan</h1>
        {hint && <p className="error">{hint}</p>}
        <p className="muted">Create the first account. This account is the admin and can add others later.</p>
        <label className="field">
          <span>Setup code</span>
          <input
            className="input"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="XXXX-XXXX-XXXX"
            required
            autoFocus
          />
          <span className="muted small">
            The server prints it in its log when it starts: <code>docker logs clockspan</code>, or the container&apos;s log in Unraid.
          </span>
        </label>
        <label className="field">
          <span>Username</span>
          <input className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <NewPasswordFields label="Password" value={password} confirm={confirm} onValue={setPassword} onConfirm={setConfirm} />
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary btn-lg" type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create account'}
        </button>
      </form>
    </div>
  );
}
