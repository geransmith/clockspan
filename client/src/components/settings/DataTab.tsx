import { useEffect, useState } from 'react';
import { MAX_RETENTION_DAYS, MIN_RETENTION_DAYS } from '../../../../shared/settings.js';
import * as api from '../../api';
import { DELETE_DAYS, RESET_SETTINGS } from '../../lib/copy';
import { addDays, todayKey } from '../../../../shared/dates.js';
import { formatDateFull, plural } from '../../lib/format';
import type { PruneInfo, Settings } from '../../types';
import { Toggle } from '../Toggle';
import { NumberField, Section } from './controls';

export function DataTab({ settings, set, onReset }: { settings: Settings; set: (patch: Partial<Settings>) => void; onReset: () => void }) {
  return (
    <>
      <Section
        title="Automatic cleanup"
        hint="Deletes days older than this, with their punches, priorities, sessions, breaks and notes. Settings are kept. Runs on the server every few hours."
      >
        <Toggle
          label="Delete old days automatically"
          checked={settings.retention.enabled}
          onChange={(v) => set({ retention: { ...settings.retention, enabled: v } })}
        />
        <NumberField
          label="Keep the last"
          unit="days"
          value={settings.retention.days}
          min={MIN_RETENTION_DAYS}
          max={MAX_RETENTION_DAYS}
          disabled={!settings.retention.enabled}
          onCommit={(m) => set({ retention: { ...settings.retention, days: m } })}
        />
      </Section>
      <DeleteOldDays />
      <Section title="Reset" hint={RESET_SETTINGS.hint}>
        <div>
          <button className="btn btn-ghost btn-danger-text" onClick={onReset}>
            {RESET_SETTINGS.button}
          </button>
        </div>
      </Section>
      <p className="muted small">
        Clockspan v{__APP_VERSION__} · data stays on your server ·{' '}
        <a className="about-link" href="https://github.com/geransmith/clockspan/releases" target="_blank" rel="noreferrer">
          Release notes
        </a>
      </p>
    </>
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
      .catch((err: unknown) => !cancelled && setMsg({ ok: false, text: (err as Error).message }));
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
      : `${info.total} ${plural(info.total, 'day')} stored, oldest ${formatDateFull(info.oldest!)}. ${info.matching} before this date.`;

  return (
    <Section
      title="Delete old days now"
      hint="Removes every day before the date, with its punches, priorities, sessions, breaks and notes. Today and a day with a running timer are always kept."
    >
      <div className="setting-row">
        <span>Delete days before</span>
        <span className="duration-inputs">
          <input
            className="input"
            type="date"
            value={before}
            max={today}
            // `max` doesn't stop a typed date, and a cutoff after today would delete today too.
            onChange={(e) => {
              if (!e.target.value) return;
              setBefore(e.target.value < today ? e.target.value : today);
              // The count and any message were for the old date: Delete waits for the new count.
              setInfo(null);
              setMsg(null);
            }}
            aria-label="Delete days before"
          />
          <button className="btn btn-ghost btn-danger-text" onClick={() => void remove()} disabled={busy || !info || info.matching === 0}>
            Delete…
          </button>
        </span>
      </div>
      {stored && <p className="muted small">{stored}</p>}
      {info?.serverMaxDays != null && <p className="muted small">This server keeps at most {info.serverMaxDays} days for every user.</p>}
      {msg && (
        <p className={msg.ok ? 'success' : 'error'} role={msg.ok ? undefined : 'alert'}>
          {msg.text}
        </p>
      )}
    </Section>
  );
}
