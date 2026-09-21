import { useState, type FormEvent } from 'react';
import * as api from '../api';
import { HTTPS_ONLY } from '../lib/copy';
import type { AuthInfo } from '../types';

interface GateProps {
  /** Re-reads the auth state; the answer says whether the sign-in stuck. */
  onDone: () => Promise<AuthInfo | null>;
  /** A line above the form when a sign-in from this page cannot work (plain http, Secure cookie). */
  hint?: string | null;
}

export function LoginPage({ onDone, hint }: GateProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(username.trim(), password);
      // A 200 with no session on the next request: the browser dropped the cookie.
      const next = await onDone();
      if (next && !next.user) setError(HTTPS_ONLY.notKept);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gate">
      <form className="gate-card" onSubmit={submit}>
        <h1>Clockspan</h1>
        {hint && <p className="error">{hint}</p>}
        <label className="field">
          <span>Username</span>
          <input className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
        </label>
        <label className="field">
          <span>Password</span>
          <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary btn-lg" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

export function OidcLoginPage({ hint }: { hint?: string | null }) {
  return (
    <div className="gate">
      <div className="gate-card">
        <h1>Clockspan</h1>
        {hint && <p className="error">{hint}</p>}
        <p className="muted">Sign in with your identity provider to continue.</p>
        <a className="btn btn-primary btn-lg" href="/auth/login">
          Sign in
        </a>
      </div>
    </div>
  );
}
