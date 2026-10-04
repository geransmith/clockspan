import { SETTING_LIMITS, TIME_FORMATS, type TimeFormat } from '../../../../shared/settings.js';
import type { Settings } from '../../types';
import { DurationField } from '../DurationField';
import { Toggle } from '../Toggle';
import { NumberField, Section } from './controls';

const TIME_FORMAT_LABELS: Record<TimeFormat, string> = { auto: 'Automatic', '12h': '12-hour', '24h': '24-hour' };

export function TimeclockTab({ settings, set }: { settings: Settings; set: (patch: Partial<Settings>) => void }) {
  return (
    <Section title="Timeclock" hint="Used to work out your clock-out time, and the meal periods when they apply.">
      <DurationField label="Work day" minutes={settings.workMinutes} {...SETTING_LIMITS.workMinutes} onCommit={(m) => set({ workMinutes: m })} />
      <Toggle
        label="Meal periods"
        hint="The lunch deadline and the second meal period, with their alarms and the Lunch by tile. Off for salaried or exempt work, or where other rules apply."
        checked={settings.mealRules}
        onChange={(v) => set({ mealRules: v })}
      />
      {!settings.mealRules && (
        <Toggle
          label="Lunch punches"
          hint="The Lunch out and Lunch in rows on the timeclock, and the Lunch taken sticker. Off hides the rows, except on a day with a lunch already punched, and drops the sticker."
          checked={settings.lunchPunches}
          onChange={(v) => set({ lunchPunches: v })}
        />
      )}
      {settings.mealRules && (
        <>
          <DurationField
            label="Lunch must start within"
            minutes={settings.lunchDeadlineMinutes}
            {...SETTING_LIMITS.lunchDeadlineMinutes}
            onCommit={(m) => set({ lunchDeadlineMinutes: m })}
          />
          <NumberField label="Lunch length" value={settings.lunchMinutes} {...SETTING_LIMITS.lunchMinutes} onCommit={(m) => set({ lunchMinutes: m })} />
          <DurationField
            label="Second meal due after (hours worked)"
            minutes={settings.secondMealAfterMinutes}
            {...SETTING_LIMITS.secondMealAfterMinutes}
            onCommit={(m) => set({ secondMealAfterMinutes: m })}
          />
        </>
      )}
      <Toggle
        label="Overtime"
        hint={`An 'Overtime approved' switch on the timeclock and the clock-out alarm. It silences that day's clock-out alarm only${settings.mealRules ? '; meal alarms stay on' : ''}. Off where overtime doesn't apply: time past your day isn't shown as overtime.`}
        checked={settings.overtimeApproval}
        onChange={(v) => set({ overtimeApproval: v })}
      />
      <Toggle
        label="Show hours"
        hint="The week line, the hours in History and the review, and the Clocked out sticker. Off if you don't track hours."
        checked={settings.trackHours}
        onChange={(v) => set({ trackHours: v })}
      />
      {settings.trackHours && (
        <>
          <DurationField label="Work week" minutes={settings.weekMinutes} {...SETTING_LIMITS.weekMinutes} onCommit={(m) => set({ weekMinutes: m })} />
          <p className="muted small">The timeclock counts the week so far against this. 0 hides that line.</p>
        </>
      )}
      <div className="setting-row">
        <span>Time format</span>
        <select
          className="input select"
          value={settings.timeFormat}
          onChange={(e) => set({ timeFormat: e.target.value as TimeFormat })}
          aria-label="Time format"
        >
          {TIME_FORMATS.map((f) => (
            <option key={f} value={f}>
              {TIME_FORMAT_LABELS[f]}
            </option>
          ))}
        </select>
      </div>
    </Section>
  );
}
