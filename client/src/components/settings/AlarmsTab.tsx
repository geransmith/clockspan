import { useRef, useState } from 'react';
import { SOUND_EVENTS, SOUNDS } from '../../../../shared/sounds.js';
import { BREAK_HOLD_MINUTES, NO_BREAK_MINUTES } from '../../lib/alarms';
import { notificationPermission, playSound, requestNotificationPermission } from '../../lib/alerts';
import { SOUND_EVENT_LABELS } from '../../lib/sounds';
import type { AlarmId, AlarmSettings, SoundEvent, SoundId } from '../../types';
import { Toggle } from '../Toggle';
import { Section, type TabProps } from './controls';

const LEAD_CHOICES = [30, 15, 10, 5, 1];
const REPEAT_CHOICES = [0, 1, 2, 5, 10, 15, 60];

export function AlarmsTab({ settings, set }: TabProps) {
  const setAlarm = (id: AlarmId, patch: Partial<AlarmSettings>) => set({ alarms: { [id]: patch } });
  const setSound = (event: SoundEvent, id: SoundId) => set({ sounds: { [event]: id } });
  return (
    <>
      <Section
        title="Alarms"
        hint={
          settings.mealRules
            ? `Alerts as lunch, clock-out and the second meal period approach, when lunch is over, a nudge to look back before the day ends, and one after ${NO_BREAK_MINUTES} minutes without a break.`
            : `Alerts as clock-out approaches, a nudge to look back before the day ends, and one after ${NO_BREAK_MINUTES} minutes without a break.`
        }
      >
        {settings.mealRules && (
          <>
            <AlarmEditor title="Lunch deadline" alarm={settings.alarms.lunchBy} onChange={(p) => setAlarm('lunchBy', p)} />
            <AlarmEditor title="Lunch end" noWarnings alarm={settings.alarms.lunchEnd} onChange={(p) => setAlarm('lunchEnd', p)} />
          </>
        )}
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
          hint={`Compare the plan with the day log before you clock out. 'Warn before' is how long before clock-out.${settings.overtimeApproval ? " Overtime approval doesn't silence it." : ''}`}
          alarm={settings.alarms.retro}
          onChange={(p) => setAlarm('retro', p)}
        />
        <AlarmEditor
          title="Break"
          hint={`Rings after ${NO_BREAK_MINUTES} minutes without a break, counted from your last break or your last In punch. Waits while a timer or a break runs.`}
          hintTitle={
            settings.mealRules
              ? `Stays quiet from ${BREAK_HOLD_MINUTES} min before a lunch or clock-out deadline until lunch is taken, the day ends or overtime is approved.`
              : `Stays quiet from ${BREAK_HOLD_MINUTES} min before the clock-out deadline until the day ends or overtime is approved.`
          }
          noWarnings
          alarm={settings.alarms.noBreak}
          onChange={(p) => setAlarm('noBreak', p)}
        />
      </Section>
      <Section title="How You're Alerted" hint="Every alarm also shows an in-app banner. Alarms ring while Clockspan is open in a tab or the installed app.">
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

function AlarmEditor({
  title,
  hint,
  hintTitle,
  noWarnings,
  alarm,
  onChange,
}: {
  title: string;
  hint?: string;
  hintTitle?: string;
  noWarnings?: boolean;
  alarm: AlarmSettings;
  onChange: (p: Partial<AlarmSettings>) => void;
}) {
  const toggleLead = (m: number) => {
    const has = alarm.leadMinutes.includes(m);
    onChange({ leadMinutes: (has ? alarm.leadMinutes.filter((x) => x !== m) : [...alarm.leadMinutes, m]).sort((a, b) => b - a) });
  };
  // Every alarm has the same chips and fields, less the Warn before row for one with no warnings;
  // the group gives each set the alarm's name.
  return (
    <div className="alarm-editor" role="group" aria-label={title}>
      <Toggle label={title} hint={hint} hintTitle={hintTitle} checked={alarm.enabled} onChange={(v) => onChange({ enabled: v })} />
      <div className="alarm-fields">
        {!noWarnings && (
          <div className="setting-row">
            <span className="muted small">Warn before</span>
            <span className="chips" role="group" aria-label="Warn before">
              {LEAD_CHOICES.map((m) => (
                <button key={m} className="chip" onClick={() => toggleLead(m)} disabled={!alarm.enabled} aria-pressed={alarm.leadMinutes.includes(m)}>
                  {m}m
                </button>
              ))}
            </span>
          </div>
        )}
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
                  {m === 0 ? 'Off' : `Every ${m} min`}
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
      <span className="inline-controls">
        <select className="input select" value={value} onChange={(e) => onChange(e.target.value as SoundId)} disabled={disabled} aria-label={`${label} sound`}>
          {SOUNDS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <button className="btn btn-ghost" onClick={() => playSound(value)} disabled={disabled || value === 'none'} aria-label={`Test ${label} sound`}>
          Test
        </button>
      </span>
    </div>
  );
}

function NotificationsRow({ enabled, onChange }: { enabled: boolean; onChange: (v: boolean) => void }) {
  const [perm, setPerm] = useState(notificationPermission());
  const row = useRef<HTMLDivElement>(null);
  const request = async () => {
    const answer = await requestNotificationPermission();
    // Allow goes once the browser has answered, so a focus still on it moves to the switch beside it.
    if (answer !== 'default' && row.current?.contains(document.activeElement)) row.current.querySelector<HTMLElement>('[role="switch"]')?.focus();
    setPerm(answer);
  };
  const hint =
    perm === 'insecure'
      ? 'Needs HTTPS. Over plain http, alarms are a sound and a banner.'
      : perm === 'unsupported'
        ? 'On iPhone, notifications work only from Clockspan added to the Home Screen.'
        : perm === 'denied'
          ? 'Blocked in your browser settings for this site.'
          : perm === 'granted'
            ? 'Enabled in this browser.'
            : 'Not allowed in this browser yet. Until then, alarms are a sound and a banner.';
  return (
    <div className="setting-row" ref={row}>
      <Toggle label="Browser notifications" hint={hint} checked={enabled} onChange={onChange} />
      {perm === 'default' && (
        <button className="btn btn-ghost" onClick={() => void request()}>
          Allow
        </button>
      )}
    </div>
  );
}
