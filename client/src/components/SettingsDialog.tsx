import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { MAX_RETENTION_DAYS, MIN_RETENTION_DAYS, type TimeFormat } from '../../../shared/settings.js';
import { SOUND_EVENTS, SOUNDS } from '../../../shared/sounds.js';
import * as api from '../api';
import { useAuth } from '../auth/AuthGate';
import { useModalDialog } from '../hooks/useModalDialog';
import { useSettings } from '../hooks/useSettings';
import { notificationPermission, playSound, requestNotificationPermission, unlockAudio } from '../lib/alerts';
import { CONFIRM, DELETE_DAYS, RESET_SETTINGS, SAVE_STATUS } from '../lib/copy';
import { addDays, formatDateFull, todayKey } from '../lib/format';
import { DEFAULT_LAYOUT } from '../lib/layout';
import { SOUND_EVENT_LABELS } from '../lib/sounds';
import { readStored, writeStored } from '../lib/storage';
import type { AlarmId, AlarmSettings, PruneInfo, PublicUser, Settings, SoundEvent, SoundId } from '../types';
import { Check, X } from './Icons';

const LEAD_CHOICES = [30, 15, 10, 5, 1];
const REPEAT_CHOICES = [0, 1, 2, 5, 10, 15];

type TabId = 'timeclock' | 'alarms' | 'sheet' | 'data' | 'account';
const TABS: { id: TabId; label: string }[] = [
  { id: 'timeclock', label: 'Timeclock' },
  { id: 'alarms', label: 'Alarms' },
  { id: 'sheet', label: 'Sheet' },
  { id: 'data', label: 'Data' },
  { id: 'account', label: 'Account' },
];
const TAB_STORAGE_KEY = 'focus:settingsTab';

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { settings, update, reset } = useSettings();
  const { auth } = useAuth();
  const { saveState, save } = useSaveStatus();
  // Account holds password + users, which only exist with local accounts.
  const tabs = TABS.filter((t) => t.id !== 'account' || auth.mode === 'local');
  const [tab, setTab] = useLastTab(tabs);

  // Focus lands on the dialog, not on the Close button, where Enter would shut what was just opened.
  const dialog = useModalDialog(onClose);

  const set = (patch: Partial<Settings>) => void save(() => update(patch));
  const setAlarm = (id: AlarmId, patch: Partial<AlarmSettings>) => set({ alarms: { ...settings.alarms, [id]: { ...settings.alarms[id], ...patch } } });
  const setSound = (event: SoundEvent, id: SoundId) => set({ sounds: { ...settings.sounds, [event]: id } });
  const onReset = () => {
    if (window.confirm(RESET_SETTINGS.confirm)) void save(reset);
  };

  // Left/Right move between tabs, as the ARIA tabs pattern expects.
  // Roving tabindex: arrows move between the tabs, bound on each tab (the focusable element).
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const i = tabs.findIndex((t) => t.id === tab);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    if (!next) return;
    setTab(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  };

  const panel = () => {
    switch (tab) {
      case 'timeclock':
        return (
          <Section title="Timeclock" hint="Used to compute your lunch deadline, clock-out time and second meal period.">
            <DurationField label="Work day" minutes={settings.workMinutes} onCommit={(m) => set({ workMinutes: m })} />
            <DurationField label="Lunch must start within" minutes={settings.lunchDeadlineMinutes} onCommit={(m) => set({ lunchDeadlineMinutes: m })} />
            <MinutesField label="Lunch length" minutes={settings.lunchMinutes} min={0} max={480} onCommit={(m) => set({ lunchMinutes: m })} />
            <DurationField
              label="Second meal due after (hours worked)"
              minutes={settings.secondMealAfterMinutes}
              onCommit={(m) => set({ secondMealAfterMinutes: m })}
            />
            <div className="setting-row">
              <span>Time format</span>
              <select
                className="input select"
                value={settings.timeFormat}
                onChange={(e) => set({ timeFormat: e.target.value as TimeFormat })}
                aria-label="Time format"
              >
                <option value="auto">Automatic</option>
                <option value="12h">12-hour</option>
                <option value="24h">24-hour</option>
              </select>
            </div>
            <Toggle
              label="Overtime approval"
              hint="Adds an 'Overtime approved' switch to the timeclock and to the clock-out alarm. It silences that day's clock-out alarm only; meal alarms stay on. Turn off if overtime doesn't apply to you."
              checked={settings.overtimeApproval}
              onChange={(v) => set({ overtimeApproval: v })}
            />
          </Section>
        );
      case 'alarms':
        return (
          <>
            <Section title="Alarms" hint="Alerts as lunch, clock-out and the second meal period approach, and a nudge to look back before the day ends.">
              <AlarmEditor title="Lunch deadline" alarm={settings.alarms.lunchBy} onChange={(p) => setAlarm('lunchBy', p)} />
              <AlarmEditor title="Clock-out" alarm={settings.alarms.clockOut} onChange={(p) => setAlarm('clockOut', p)} />
              <AlarmEditor
                title="Second meal period"
                hint="California: due before the end of the 10th hour worked on days over 10 hours (waivable when the day is 12 hours or less). Only arms on a day that's heading past the threshold. Turn off if you've waived it."
                alarm={settings.alarms.secondMeal}
                onChange={(p) => setAlarm('secondMeal', p)}
              />
              <AlarmEditor
                title="Retrospective"
                hint="Compare the plan with the day log before you clock out. 'Warn before' is how long before clock-out. Overtime approval doesn't silence it."
                alarm={settings.alarms.retro}
                onChange={(p) => setAlarm('retro', p)}
              />
            </Section>
            <Section title="How you're alerted" hint="Every alarm also shows an in-app banner.">
              <Toggle label="Sound" checked={settings.sound} onChange={(v) => set({ sound: v })} />
              <NotificationsRow enabled={settings.notifications} onChange={(v) => set({ notifications: v })} />
            </Section>
            <Section title="Sounds" hint="What plays for each event. The Sound switch above silences all of them.">
              {SOUND_EVENTS.map((event) => (
                <SoundRow key={event} event={event} value={settings.sounds[event]} disabled={!settings.sound} onChange={(id) => setSound(event, id)} />
              ))}
            </Section>
          </>
        );
      case 'sheet':
        return (
          <>
            <Section title="Priorities">
              <MinutesField label="Rows per day" unit="rows" minutes={settings.priorityCount} min={1} max={10} onCommit={(m) => set({ priorityCount: m })} />
              <p className="muted small">New days start with this many rows. Add more on the sheet any time.</p>
            </Section>
            <Section title="Focus timer">
              <MinutesField
                label="Adjust step (± buttons)"
                minutes={settings.adjustStepMinutes}
                min={1}
                max={60}
                onCommit={(m) => set({ adjustStepMinutes: m })}
              />
              <Toggle
                label="Keep screen awake while a timer runs"
                hint="Stops phones from sleeping mid-session so the chime can play."
                checked={settings.keepScreenAwake}
                onChange={(v) => set({ keepScreenAwake: v })}
              />
            </Section>
            <Section title="Celebrations">
              <Toggle
                label="Emoji bursts"
                hint="A short burst when you tick a priority or finish the day."
                checked={settings.celebrations}
                onChange={(v) => set({ celebrations: v })}
              />
            </Section>
            <Section title="History">
              <Toggle
                label="Sticker chart"
                hint="Every day on the calendar wears a sticker for each thing it did: clocked out, lunch taken, all priorities done, a focus session logged, retrospective reviewed."
                checked={settings.stickers}
                onChange={(v) => set({ stickers: v })}
              />
              <Toggle
                label="Show weekends"
                hint="Off hides Saturday and Sunday from the calendar and its sticker counts."
                checked={settings.showWeekends}
                onChange={(v) => set({ showWeekends: v })}
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
          </>
        );
      case 'data':
        return (
          <>
            <Section
              title="Automatic cleanup"
              hint="Deletes days older than this, with their punches, priorities, sessions and notes. Settings are kept. Runs on the server every few hours."
            >
              <Toggle
                label="Delete old days automatically"
                checked={settings.retention.enabled}
                onChange={(v) => set({ retention: { ...settings.retention, enabled: v } })}
              />
              <MinutesField
                label="Keep the last"
                unit="days"
                minutes={settings.retention.days}
                min={MIN_RETENTION_DAYS}
                max={MAX_RETENTION_DAYS}
                disabled={!settings.retention.enabled}
                onCommit={(m) => set({ retention: { ...settings.retention, days: m } })}
              />
            </Section>
            <DeleteOldDays />
          </>
        );
      case 'account':
        return (
          <>
            <Section title="Password">
              <ChangePassword />
            </Section>
            {auth.user?.isAdmin && (
              <Section title="Users" hint="Each user has their own sheet, history and settings.">
                <Users me={auth.user} />
              </Section>
            )}
          </>
        );
    }
  };

  return (
    <dialog {...dialog} className="dialog" aria-labelledby="settings-title">
      <div className="dialog-inner">
        <header className="dialog-head">
          <h2 id="settings-title">Settings</h2>
          <SaveStatus state={saveState} />
          <button className="btn btn-icon" onClick={onClose} aria-label="Close settings">
            <X />
          </button>
        </header>
        <div className="tabs" role="tablist" aria-label="Settings sections">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              className={`tab${tab === t.id ? ' is-active' : ''}`}
              onClick={() => setTab(t.id)}
              onKeyDown={onTabKey}
            >
              {t.label}
            </button>
          ))}
        </div>
        {/* Keyed so switching tabs starts each panel at the top instead of mid-scroll. */}
        <div key={tab} className="dialog-body" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
          {saveState === 'failed' && <p className="notice notice--danger">{SAVE_STATUS.failedDetail}</p>}
          {panel()}
        </div>
        <footer className="dialog-foot">
          <span className="muted small">Clockspan · data stays on your server</span>
          <button className="btn btn-ghost btn-danger-text" onClick={onReset}>
            {RESET_SETTINGS.button}
          </button>
        </footer>
      </div>
    </dialog>
  );
}

/** The tab you were on last time, so reopening the dialog to tweak the same thing doesn't start over. */
function useLastTab(tabs: { id: TabId }[]): [TabId, (t: TabId) => void] {
  const [tab, setTab] = useState<TabId>(() => {
    const stored = readStored(TAB_STORAGE_KEY);
    return tabs.find((t) => t.id === stored)?.id ?? tabs[0]?.id ?? 'timeclock';
  });
  useEffect(() => writeStored(TAB_STORAGE_KEY, tab), [tab]);
  return [tab, setTab];
}

type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

/**
 * Tracks in-flight settings saves so the header can say "Saving…", then "Saved" once the server
 * has confirmed, or "Not saved" when the provider had to roll the change back. In-flight saves
 * are counted so a burst of chip clicks reads as one save instead of flickering between states.
 * `run` is any provider call that settles when the server has answered (update or reset).
 */
function useSaveStatus() {
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const pending = useRef(0);
  const failed = useRef(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const save = useCallback(async (run: () => Promise<void>) => {
    if (pending.current === 0) failed.current = false;
    pending.current++;
    if (timer.current) window.clearTimeout(timer.current);
    setSaveState('saving');
    try {
      await run();
    } catch {
      // The provider already put the old value back; all that is left is to say so.
      failed.current = true;
    } finally {
      pending.current--;
      if (pending.current === 0) {
        if (failed.current) setSaveState('failed');
        else {
          setSaveState('saved');
          timer.current = window.setTimeout(() => setSaveState('idle'), 2500);
        }
      }
    }
  }, []);

  return { saveState, save };
}

/** Always rendered, empty when idle: a live region has to exist before its text changes to be announced. */
function SaveStatus({ state }: { state: SaveState }) {
  const pill = state === 'saved' ? ' pill pill--ok' : state === 'failed' ? ' pill pill--danger' : state === 'saving' ? ' pill' : '';
  return (
    <span className={`save-status${pill}`} role="status" aria-live="polite">
      {state === 'saving' && SAVE_STATUS.saving}
      {state === 'saved' && (
        <>
          <Check />
          {SAVE_STATUS.saved}
        </>
      )}
      {state === 'failed' && SAVE_STATUS.failed}
    </span>
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
      <input type="checkbox" role="switch" aria-checked={checked} className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/** Hours + minutes inputs that commit on blur/Enter, so half-typed values never save. */
function DurationField({ label, minutes, onCommit }: { label: string; minutes: number; onCommit: (m: number) => void }) {
  const [h, setH] = useState(String(Math.floor(minutes / 60)));
  const [m, setM] = useState(String(minutes % 60));
  // A new value from outside (save confirmed, reset) replaces the draft; React's
  // "adjust state while rendering" form, so it lands in the same render.
  const [seen, setSeen] = useState(minutes);
  if (minutes !== seen) {
    setSeen(minutes);
    setH(String(Math.floor(minutes / 60)));
    setM(String(minutes % 60));
  }
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
        <input
          className="input input-num"
          inputMode="numeric"
          value={h}
          onChange={(e) => setH(e.target.value)}
          onBlur={commit}
          onKeyDown={onKey}
          aria-label={`${label} hours`}
        />
        <span className="muted">h</span>
        <input
          className="input input-num"
          inputMode="numeric"
          value={m}
          onChange={(e) => setM(e.target.value)}
          onBlur={commit}
          onKeyDown={onKey}
          aria-label={`${label} minutes`}
        />
        <span className="muted">m</span>
      </span>
    </div>
  );
}

/** A single whole-number input; `unit` is the suffix ("min" by default). */
function MinutesField({
  label,
  minutes,
  min,
  max,
  unit = 'min',
  disabled,
  onCommit,
}: {
  label: string;
  minutes: number;
  min: number;
  max: number;
  unit?: string;
  disabled?: boolean;
  onCommit: (m: number) => void;
}) {
  const [v, setV] = useState(String(minutes));
  const [seen, setSeen] = useState(minutes);
  if (minutes !== seen) {
    setSeen(minutes);
    setV(String(minutes));
  }
  const commit = () => {
    const n = Math.max(min, Math.min(max, Math.round(Number(v) || 0)));
    if (n !== minutes) onCommit(n);
    else setV(String(minutes));
  };
  return (
    <div className="setting-row">
      <span>{label}</span>
      <span className="duration-inputs">
        <input
          className="input input-num"
          inputMode="numeric"
          value={v}
          onChange={(e) => setV(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          aria-label={label}
          disabled={disabled}
        />
        <span className="muted">{unit}</span>
      </span>
    </div>
  );
}

function AlarmEditor({ title, hint, alarm, onChange }: { title: string; hint?: string; alarm: AlarmSettings; onChange: (p: Partial<AlarmSettings>) => void }) {
  const toggleLead = (m: number) => {
    const has = alarm.leadMinutes.includes(m);
    onChange({ leadMinutes: (has ? alarm.leadMinutes.filter((x) => x !== m) : [...alarm.leadMinutes, m]).sort((a, b) => b - a) });
  };
  return (
    <div className={`alarm-editor${alarm.enabled ? '' : ' is-off'}`}>
      <Toggle label={title} hint={hint} checked={alarm.enabled} onChange={(v) => onChange({ enabled: v })} />
      <div className="alarm-fields">
        <div className="setting-row">
          <span className="muted small">Warn before</span>
          <span className="chips">
            {LEAD_CHOICES.map((m) => (
              <button
                key={m}
                className={`chip${alarm.leadMinutes.includes(m) ? ' is-on' : ''}`}
                onClick={() => toggleLead(m)}
                disabled={!alarm.enabled}
                aria-pressed={alarm.leadMinutes.includes(m)}
              >
                {m}m
              </button>
            ))}
          </span>
        </div>
        <div className="setting-row">
          <label className="inline-check">
            <input
              type="checkbox"
              className="checkbox"
              checked={alarm.onDue}
              onChange={(e) => onChange({ onDue: e.target.checked })}
              disabled={!alarm.enabled}
            />
            <span>When reached</span>
          </label>
          <label className="inline-check">
            <span className="muted small">Repeat while over</span>
            <select
              className="input select"
              value={alarm.overdueEveryMinutes}
              onChange={(e) => onChange({ overdueEveryMinutes: Number(e.target.value) })}
              disabled={!alarm.enabled}
            >
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

/** One event's sound: a pick from the catalog and a Test button that plays the pick. */
function SoundRow({ event, value, disabled, onChange }: { event: SoundEvent; value: SoundId; disabled: boolean; onChange: (id: SoundId) => void }) {
  const label = SOUND_EVENT_LABELS[event];
  return (
    <div className="setting-row">
      <span>{label}</span>
      <span className="duration-inputs">
        <select className="input select" value={value} onChange={(e) => onChange(e.target.value as SoundId)} disabled={disabled} aria-label={`${label} sound`}>
          {SOUNDS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <button
          className="btn btn-ghost"
          onClick={() => {
            unlockAudio();
            playSound(value);
          }}
          disabled={disabled || value === 'none'}
          aria-label={`Test ${label} sound`}
        >
          Test
        </button>
      </span>
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

/**
 * Settings → Data → "Delete old days now". The count line is the server's answer for the
 * chosen cutoff, so the confirm names exactly what will go. Not a settings save: nothing here
 * goes through the header's Saving/Saved pill.
 */
function DeleteOldDays() {
  const today = todayKey();
  const [before, setBefore] = useState(() => addDays(today, -365));
  const [info, setInfo] = useState<PruneInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getPruneInfo(before)
      .then((r) => !cancelled && setInfo(r))
      .catch((err) => !cancelled && setMsg({ ok: false, text: (err as Error).message }));
    return () => {
      cancelled = true;
    };
  }, [before]);

  const remove = async () => {
    if (!info || !window.confirm(DELETE_DAYS.confirm(info.matching, formatDateFull(before)))) return;
    setBusy(true);
    setMsg(null);
    try {
      const { deleted } = await api.pruneDays(before);
      setMsg({ ok: true, text: DELETE_DAYS.done(deleted) });
      setInfo(await api.getPruneInfo(before));
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const stored = !info
    ? null
    : info.total === 0
      ? 'No days stored.'
      : `${info.total} day${info.total === 1 ? '' : 's'} stored, oldest ${formatDateFull(info.oldest!)}. ${info.matching} before this date.`;

  return (
    <Section
      title="Delete old days now"
      hint="Removes every day before the date, with its punches, priorities, sessions and notes. Today and a day with a running timer are always kept."
    >
      <div className="setting-row">
        <span>Delete days before</span>
        <span className="duration-inputs">
          <input
            className="input"
            type="date"
            value={before}
            max={today}
            onChange={(e) => e.target.value && setBefore(e.target.value)}
            aria-label="Delete days before"
          />
          <button className="btn btn-ghost btn-danger-text" onClick={() => void remove()} disabled={busy || !info || info.matching === 0}>
            Delete…
          </button>
        </span>
      </div>
      {stored && <p className="muted small">{stored}</p>}
      {info?.serverMaxDays != null && <p className="muted small">This server keeps at most {info.serverMaxDays} days for every user.</p>}
      {msg && <p className={msg.ok ? 'success' : 'error'}>{msg.text}</p>}
    </Section>
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
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          minLength={8}
          required
        />
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
  const load = () =>
    api
      .listUsers()
      .then((r) => setUsers(r.users))
      .catch((err) => setError((err as Error).message));
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
        <input
          className="input"
          type="password"
          placeholder="Temporary password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={8}
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
