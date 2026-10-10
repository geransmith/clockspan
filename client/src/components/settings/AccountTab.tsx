import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../../api';
import { useSubmit } from '../../hooks/useSubmit';
import { unlessGone } from '../../lib/apiError';
import { CONFIRM, PASSWORD_CHANGED, PASSWORD_MISMATCH } from '../../lib/copy';
import type { PublicUser } from '../../types';
import { HiddenUsername, NewPasswordFields, NewPasswordInput } from '../NewPasswordFields';
import { UsernameInput } from '../UsernameInput';
import { Section } from './controls';
import { ErrorLine } from '../ErrorLine';
import { Avatar } from '../Avatar';

export function AccountTab({ user }: { user: PublicUser }) {
  return (
    <>
      <Section title="Password">
        <ChangePassword username={user.username ?? ''} />
      </Section>
      {user.isAdmin && (
        <Section
          title="Users"
          hint="Each user has their own sheet, history and settings. A new user signs in with the temporary password you give them, then chooses their own."
        >
          <Users me={user} />
        </Section>
      )}
    </>
  );
}

function ChangePassword({ username }: { username: string }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const { busy, error, onSubmit } = useSubmit();
  const submit = onSubmit(async () => {
    setDone(false);
    if (next !== confirm) throw new Error(PASSWORD_MISMATCH);
    await api.changePassword(current, next);
    setDone(true);
    setCurrent('');
    setNext('');
    setConfirm('');
  });
  return (
    <form className="stack" onSubmit={submit}>
      <HiddenUsername username={username} />
      <label className="field">
        <span>Current password</span>
        <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </label>
      <NewPasswordFields value={next} confirm={confirm} onValue={setNext} onConfirm={setConfirm} />
      <ErrorLine error={error} />
      {/* Always there, so a screen reader hears the line arrive. */}
      <p className="success" role="status">
        {done && PASSWORD_CHANGED}
      </p>
      <div>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          Change password
        </button>
      </div>
    </form>
  );
}

function Users({ me }: { me: PublicUser }) {
  const [users, setUsers] = useState<PublicUser[] | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const usernameBox = useRef<HTMLInputElement>(null);
  // The list's load and delete share the add form's error line.
  const { busy, error, setError, run, onSubmit } = useSubmit();
  const load = useCallback(
    () =>
      api
        .listUsers()
        .then((r) => setUsers(r.users))
        .catch((err: unknown) => setError((err as Error).message)),
    [setError],
  );
  useEffect(() => void load(), [load]);

  const add = onSubmit(async () => {
    await api.addUser(username, password);
    setUsername('');
    setPassword('');
    await load();
  });
  const remove = (u: PublicUser) => {
    if (!window.confirm(CONFIRM.deleteUser(u.name))) return;
    run(async () => {
      try {
        // A 404: another device deleted the user already, which is what was asked.
        await unlessGone(api.deleteUser(u.id));
      } finally {
        // Reload either way, so the list shows what the server holds.
        await load();
        // Every Delete is disabled while this runs, and this one may go with its row: a focus that
        // fell to the page, or is still on that button, moves to the add form.
        if (document.activeElement?.matches('body, :disabled')) usernameBox.current?.focus();
      }
    });
  };

  return (
    <div className="stack">
      <ul>
        {(users ?? []).map((u) => (
          <li key={u.id} className="user-row">
            <Avatar name={u.name} />
            <span className="user-name">
              {u.name}
              {u.isAdmin && <span className="pill pill--accent">admin</span>}
              {u.mustChangePassword && <span className="pill">temporary password</span>}
              {u.id === me.id && <span className="muted small"> (you)</span>}
            </span>
            {u.id !== me.id && (
              <button className="btn btn-ghost btn-danger-text" onClick={() => remove(u)} disabled={busy} aria-label={`Delete ${u.name}`}>
                Delete
              </button>
            )}
          </li>
        ))}
      </ul>
      <form className="user-add" onSubmit={add}>
        <UsernameInput
          ref={usernameBox}
          placeholder="Username"
          aria-label="Username"
          autoComplete="off"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <NewPasswordInput placeholder="Temporary password" aria-label="Temporary password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button className="btn btn-primary" type="submit" disabled={busy}>
          Add user
        </button>
      </form>
      <ErrorLine error={error} />
    </div>
  );
}
