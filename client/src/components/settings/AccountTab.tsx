import { useEffect, useState, type SubmitEvent } from 'react';
import * as api from '../../api';
import { CONFIRM, PASSWORD_MISMATCH } from '../../lib/copy';
import { PASSWORD_LENGTH, USERNAME, type PublicUser } from '../../types';
import { NewPasswordFields } from '../NewPasswordFields';
import { Section } from './controls';

export function AccountTab({ user }: { user: PublicUser | null }) {
  return (
    <>
      <Section title="Password">
        <ChangePassword />
      </Section>
      {user?.isAdmin && (
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

function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const submit = async (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (next !== confirm) return setMsg({ ok: false, text: PASSWORD_MISMATCH });
    try {
      await api.changePassword(current, next);
      setMsg({ ok: true, text: 'Password updated.' });
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    }
  };
  return (
    <form className="stack" onSubmit={(e) => void submit(e)}>
      <label className="field">
        <span>Current password</span>
        <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </label>
      <NewPasswordFields value={next} confirm={confirm} onValue={setNext} onConfirm={setConfirm} />
      {msg && <p className={msg.ok ? 'success' : 'error'}>{msg.text}</p>}
      <div>
        <button className="btn btn-primary" type="submit">
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
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    api
      .listUsers()
      .then((r) => setUsers(r.users))
      .catch((err: unknown) => setError((err as Error).message));
  useEffect(() => void load(), []);

  const add = async (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    try {
      await api.addUser(username.trim(), password);
      setUsername('');
      setPassword('');
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const remove = async (u: PublicUser) => {
    if (!window.confirm(CONFIRM.deleteUser(u.name))) return;
    try {
      await api.deleteUser(u.id);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="stack">
      <ul className="user-list">
        {(users ?? []).map((u) => (
          <li key={u.id} className="user-row">
            <span className="avatar" aria-hidden="true">
              {u.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="user-name">
              {u.name}
              {u.isAdmin && <span className="pill pill--accent">admin</span>}
              {u.mustChangePassword && <span className="pill">temporary password</span>}
              {u.id === me.id && <span className="muted small"> (you)</span>}
            </span>
            {u.id !== me.id && (
              <button className="btn btn-ghost btn-danger-text" onClick={() => void remove(u)}>
                Delete
              </button>
            )}
          </li>
        ))}
      </ul>
      <form className="user-add" onSubmit={(e) => void add(e)}>
        <input
          className="input"
          placeholder="Username"
          autoComplete="off"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          minLength={USERNAME.min}
          maxLength={USERNAME.max}
          pattern={USERNAME.pattern}
          title={`Only ${USERNAME.chars}`}
          required
        />
        <input
          className="input"
          type="password"
          placeholder="Temporary password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={PASSWORD_LENGTH.min}
          maxLength={PASSWORD_LENGTH.max}
          required
        />
        <button className="btn btn-primary" type="submit">
          Add user
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
