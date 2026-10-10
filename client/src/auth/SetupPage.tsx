import { useId, useState } from 'react';
import * as api from '../api';
import { NewPasswordFields, useNewPassword } from '../components/NewPasswordFields';
import { useSubmit } from '../hooks/useSubmit';
import { UsernameInput } from '../components/UsernameInput';
import type { GateProps } from './LoginPage';
import { ErrorLine } from '../components/ErrorLine';

export function SetupPage({ onDone, hint }: GateProps) {
  const [code, setCode] = useState('');
  const [username, setUsername] = useState('');
  const password = useNewPassword();
  const { busy, error, onSubmit } = useSubmit();
  const id = useId();

  const submit = onSubmit(async () => {
    await api.setup(code, username, password.checked());
    await onDone();
  });

  return (
    <div className="gate">
      <form className="gate-card" onSubmit={submit}>
        <h1>Welcome to Clockspan</h1>
        {hint && <p className="error">{hint}</p>}
        <p className="muted">Create the first account. This account is the admin and can add others later.</p>
        {/* The label wraps the hint too, which would make it part of the field's name: the title names it and the hint describes it. */}
        <label className="field">
          <span id={`${id}-label`}>Setup code</span>
          <input
            className="input"
            aria-labelledby={`${id}-label`}
            aria-describedby={`${id}-hint`}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="XXXX-XXXX-XXXX"
            required
            autoFocus
          />
          <span id={`${id}-hint`} className="muted small">
            The server prints it in its log when it starts: <code>docker logs clockspan</code>, or the container&apos;s log in Unraid.
          </span>
        </label>
        <label className="field">
          <span>Username</span>
          <UsernameInput autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <NewPasswordFields label="Password" {...password.fields} />
        <ErrorLine error={error} />
        <button className="btn btn-primary btn-lg" type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create Account'}
        </button>
      </form>
    </div>
  );
}
