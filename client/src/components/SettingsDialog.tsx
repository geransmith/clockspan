import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import * as api from '../api';
import { useAuth } from '../auth/AuthGate';
import { useSettings } from '../hooks/useSettings';
import { chime, notificationPermission, requestNotificationPermission, unlockAudio } from '../lib/alerts';
import { DEFAULT_LAYOUT } from '../lib/layout';
import type { AlarmId, AlarmSettings, PublicUser, Settings } from '../types';
import { X } from './Icons';

const LEAD_CHOICES = [30, 15, 10, 5, 1];
const REPEAT_CHOICES = [0, 1, 2, 5, 10, 15];

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { settings, update } = useSettings();
  const { auth } = useAuth();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('no-scroll');
    };
  }, [onClose]);

  const set = (patch: Partial<Settings>) => void update(patch);
  const setAlarm = (id: AlarmId, patch: Partial<AlarmSettings>) =>
    set({ alarms: { ...settings.alarms, [id]: { ...settings.alarms[id], ...patch } } });

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="dialog-head">
          <h2 id="settings-title">Settings</h2>
          <button className="btn btn-icon" onClick={onClose} aria-label="Close settings">
            <X />
          </button>
        </header>
        <div className="dialog-body">
          <Section title="Timeclock" hint="Used to compute your lunch deadline and clock-out time.">
            <DurationField label="Work day" minutes={settings.workMinutes} onCommit={(m) => set({ workMinutes: m })} />
            <DurationField label="Lunch must start within" minutes={settings.lunchDeadlineMinutes} onCommit={(m) => set({ lunchDeadlineMinutes: m })} />
            <MinutesField label="Lunch length" minutes={settings.lunchMinutes} min={0} max={480} onCommit={(m) => set({ lunchMinutes: m })} />
          </Section>

          <Section title="Alarms" hint="Alerts as lunch and clock-out approach. Chime, browser notification and an in-app banner.">
            <AlarmEditor title="Lunch deadline" alarm={settings.alarms.lunchBy} onChange={(p) => setAlarm('lunchBy', p)} />
            <AlarmEditor title="Clock-out" alarm={settings.alarms.clockOut} onChange={(p) => setAlarm('clockOut', p)} />
            <div className="setting-row">
              <Toggle label="Sound" checked={settings.sound} onChange={(v) => set({ sound: v })} />
              <button
                className="btn btn-ghost"
                onClick={() => {
                  unlockAudio();
                  chime('test');
                }}
              >
                Test sound
              </button>
            </div>
            <NotificationsRow enabled={settings.notifications} onChange={(v) => set({ notifications: v })} />
          </Section>

          <Section title="Timer">
            <MinutesField label="Adjust step (± buttons)" minutes={settings.adjustStepMinutes} min={1} max={60} onCommit={(m) => set({ adjustStepMinutes: m })} />
            <Toggle
              label="Keep screen awake while a timer runs"
              hint="Stops phones from sleeping mid-session so the chime can play."
              checked={settings.keepScreenAwake}
              onChange={(v) => set({ keepScreenAwake: v })}
            />
          </Section>

          <Section title="Layout" hint="Use Customize on the sheet to drag cards or hide them.">
            <div className="setting-row">
              <span className="muted">
                {settings.layout.filter((l) => l.visible).length} of {settings.layout.length} cards visible
              </span>
              <button className="btn btn-ghost" onClick={() => set({ layout: DEFAULT_LAYOUT })}>
                Reset to default
              </button>
            </div>
          </Section>

          {auth.mode === 'local' && (
            <Section title="Account">
              <ChangePassword />
            </Section>
          )}
          {auth.mode === 'local' && auth.user?.isAdmin && (
            <Section title="Users" hint="Each user has their own sheet, history and settings.">
              <Users me={auth.user} />
            </Section>
          )}

          <p className="muted small center">Clockspan · data stays on your server</p>
        </div>
      </div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <h3>{title}</h3>
      {hint && <p className="muted small">{hint}</p>}
      <div className="settings-fields">{children}</div>
    </section>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle-row">
      <span className="toggle-text">
        <span>{label}</span>
        {hint && <span className="muted small">{hint}</span>}
      </span>
      <input type="checkbox" role="switch" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/** Hours + minutes inputs that commit on blur/Enter, so half-typed values never save. */
function DurationField({ label, minutes, onCommit }: { label: string; minutes: number; onCommit: (m: number) => void }) {
  const [h, setH] = useState(String(Math.floor(minutes / 60)));
  const [m, setM] = useState(String(minutes % 60));
  useEffect(() => {
    setH(String(Math.floor(minutes / 60)));
    setM(String(minutes % 60));
  }, [minutes]);
  const commit = () => {
    const total = Math.max(1, Math.min(24 * 60, (Number(h) || 0) * 60 + (Number(m) || 0)));
    if (total !== minutes) onCommit(total);
    else {
      setH(String(Math.floor(minutes / 60)));
      setM(String(minutes % 60));
    }
  };
  const onKey = (e: React.KeyboardEvent) => e.key === 'Enter' && (e.target as HTMLInputElement).blur();
  return (
    <div className="setting-row">
      <span>{label}</span>
      <span className="duration-inputs">
        <input className="input input-num" inputMode="numeric" value={h} onChange={(e) => setH(e.target.value)} onBlur={commit} onKeyDown={onKey} aria-label={`${label} hours`} />
        <span className="muted">h</span>
        <input className="input input-num" inputMode="numeric" value={m} onChange={(e) => setM(e.target.value)} onBlur={commit} onKeyDown={onKey} aria-label={`${label} minutes`} />
        <span className="muted">m</span>
      </span>
    </div>
  );
}

function MinutesField({ label, minutes, min, max, onCommit }: { label: string; minutes: number; min: number; max: number; onCommit: (m: number) => void }) {
  const [v, setV] = useState(String(minutes));
  useEffect(() => setV(String(minutes)), [minutes]);
  const commit = () => {
    const n = Math.max(min, Math.min(max, Math.round(Number(v) || 0)));
    if (n !== minutes) onCommit(n);
    else setV(String(minutes));
  };
  return (
    <div className="setting-row">
      <span>{label}</span>
      <span className="duration-inputs">
        <input className="input input-num" inputMode="numeric" value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} aria-label={label} />
        <span className="muted">min</span>
      </span>
    </div>
  );
}

function AlarmEditor({ title, alarm, onChange }: { title: string; alarm: AlarmSettings; onChange: (p: Partial<AlarmSettings>) => void }) {
  const toggleLead = (m: number) => {
    const has = alarm.leadMinutes.includes(m);
    onChange({ leadMinutes: (has ? alarm.leadMinutes.filter((x) => x !== m) : [...alarm.leadMinutes, m]).sort((a, b) => b - a) });
  };
  return (
    <div className={`alarm-editor${alarm.enabled ? '' : ' is-off'}`}>
      <Toggle label={title} checked={alarm.enabled} onChange={(v) => onChange({ enabled: v })} />
      <div className="alarm-fields">
        <div className="setting-row">
          <span className="muted small">Warn before</span>
          <span className="chips">
            {LEAD_CHOICES.map((m) => (
              <button key={m} className={`chip${alarm.leadMinutes.includes(m) ? ' is-on' : ''}`} onClick={() => toggleLead(m)} disabled={!alarm.enabled} aria-pressed={alarm.leadMinutes.includes(m)}>
                {m}m
              </button>
            ))}
          </span>
        </div>
        <div className="setting-row">
          <label className="inline-check">
            <input type="checkbox" className="checkbox" checked={alarm.onDue} onChange={(e) => onChange({ onDue: e.target.checked })} disabled={!alarm.enabled} />
            <span>When reached</span>
          </label>
          <label className="inline-check">
            <span className="muted small">Repeat while over</span>
            <select className="input select" value={alarm.overdueEveryMinutes} onChange={(e) => onChange({ overdueEveryMinutes: Number(e.target.value) })} disabled={!alarm.enabled}>
              {REPEAT_CHOICES.map((m) => (
                <option key={m} value={m}>
                  {m === 0 ? 'Off' : `every ${m} min`}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
    </div>
  );
}

function NotificationsRow({ enabled, onChange }: { enabled: boolean; onChange: (v: boolean) => void }) {
  const [perm, setPerm] = useState(notificationPermission());
  const request = async () => setPerm(await requestNotificationPermission());
  const hint =
    perm === 'unsupported'
      ? 'Not supported in this browser (on iPhone, add the app to your Home Screen first).'
      : perm === 'denied'
        ? 'Blocked in your browser settings for this site.'
        : perm === 'granted'
          ? 'Enabled in this browser.'
          : 'Browser permission needed.';
  return (
    <div className="setting-row">
      <Toggle label="Browser notifications" hint={hint} checked={enabled} onChange={onChange} />
      {perm === 'default' && (
        <button className="btn btn-ghost" onClick={() => void request()}>
          Allow
        </button>
      )}
    </div>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return setMsg({ ok: false, text: 'New passwords do not match.' });
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
    <form className="stack" onSubmit={submit}>
      <label className="field">
        <span>Current password</span>
        <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </label>
      <label className="field">
        <span>New password</span>
        <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} minLength={8} required />
      </label>
      <label className="field">
        <span>Confirm new password</span>
        <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={8} required />
      </label>
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
  const load = () => api.listUsers().then((r) => setUsers(r.users)).catch((err) => setError((err as Error).message));
  useEffect(() => void load(), []);

  const add = async (e: FormEvent) => {
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
    if (!window.confirm(`Delete ${u.name} and ALL of their data? This cannot be undone.`)) return;
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
      <form className="user-add" onSubmit={add}>
        <input className="input" placeholder="Username" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} required />
        <input className="input" type="password" placeholder="Temporary password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required />
        <button className="btn btn-primary" type="submit">
          Add user
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
