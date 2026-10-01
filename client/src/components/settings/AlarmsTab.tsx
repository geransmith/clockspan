import { useState } from 'react';
import { SOUND_EVENTS, SOUNDS } from '../../../../shared/sounds.js';
import { notificationPermission, playSound, requestNotificationPermission, unlockAudio } from '../../lib/alerts';
import { SOUND_EVENT_LABELS } from '../../lib/sounds';
import type { AlarmId, AlarmSettings, Settings, SoundEvent, SoundId } from '../../types';
import { Toggle } from '../Toggle';
import { Section } from './controls';

const LEAD_CHOICES = [30, 15, 10, 5, 1];
const REPEAT_CHOICES = [0, 1, 2, 5, 10, 15];

export function AlarmsTab({ settings, set }: { settings: Settings; set: (patch: Partial<Settings>) => void }) {
  const setAlarm = (id: AlarmId, patch: Partial<AlarmSettings>) => set({ alarms: { ...settings.alarms, [id]: { ...settings.alarms[id], ...patch } } });
  const setSound = (event: SoundEvent, id: SoundId) => set({ sounds: { ...settings.sounds, [event]: id } });
  return (
    <>
      <Section
        title="Alarms"
        hint={
          settings.mealRules
            ? 'Alerts as lunch, clock-out and the second meal period approach, and a nudge to look back before the day ends.'
            : 'Alerts as clock-out approaches, and a nudge to look back before the day ends. Both count from your clock-in.'
        }
      >
        {settings.mealRules && <AlarmEditor title="Lunch deadline" alarm={settings.alarms.lunchBy} onChange={(p) => setAlarm('lunchBy', p)} />}
        <AlarmEditor title="Clock-out" alarm={settings.alarms.clockOut} onChange={(p) => setAlarm('clockOut', p)} />
        {settings.mealRules && (
          <AlarmEditor
            title="Second meal period"
            hint="California: due before the end of the 10th hour worked on days over 10 hours (waivable when the day is 12 hours or less). Only arms on a day that's heading past the threshold. Turn off if you've waived it."
            alarm={settings.alarms.secondMeal}
            onChange={(p) => setAlarm('secondMeal', p)}
          />
        )}
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
}

function AlarmEditor({ title, hint, alarm, onChange }: { title: string; hint?: string; alarm: AlarmSettings; onChange: (p: Partial<AlarmSettings>) => void }) {
  const toggleLead = (m: number) => {
    const has = alarm.leadMinutes.includes(m);
    onChange({ leadMinutes: (has ? alarm.leadMinutes.filter((x) => x !== m) : [...alarm.leadMinutes, m]).sort((a, b) => b - a) });
  };
  // Every alarm has the same chips and fields; the group gives each set the alarm's name.
  return (
    <div className="alarm-editor" role="group" aria-label={title}>
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
          <label className="inline-check alarm-on-due">
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
