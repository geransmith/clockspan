import { DEFAULT_SETTINGS, SETTING_LIMITS, TIMER_MINUTES, type Theme } from '../../../../shared/settings.js';
import type { Settings } from '../../types';
import { Toggle } from '../Toggle';
import { NumberField, NumberInput, Section } from './controls';

export function SheetTab({ settings, set }: { settings: Settings; set: (patch: Partial<Settings>) => void }) {
  return (
    <>
      <Section title="Appearance">
        <div className="setting-row">
          <span>Theme</span>
          <select className="input select" value={settings.theme} onChange={(e) => set({ theme: e.target.value as Theme })} aria-label="Theme">
            <option value="auto">Automatic</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>
        <p className="muted small">Automatic follows your device.</p>
      </Section>
      <Section title="Priorities">
        <NumberField
          label="Rows per day"
          unit="rows"
          value={settings.priorityCount}
          {...SETTING_LIMITS.priorityCount}
          onCommit={(m) => set({ priorityCount: m })}
        />
        <p className="muted small">New days start with this many rows. Add more on the sheet any time.</p>
      </Section>
      <Section title="Focus timer">
        <div className="setting-row">
          <span>Start buttons</span>
          <span className="duration-inputs">
            {settings.timerMinutes.map((m, i) => (
              <NumberInput
                key={i}
                label={`Start button ${i + 1}`}
                value={m}
                {...TIMER_MINUTES}
                onCommit={(n) => set({ timerMinutes: settings.timerMinutes.map((x, j) => (j === i ? n : x)) })}
              />
            ))}
            <span className="muted">min</span>
          </span>
        </div>
        <NumberField
          label="Adjust step (± buttons)"
          value={settings.adjustStepMinutes}
          {...SETTING_LIMITS.adjustStepMinutes}
          onCommit={(m) => set({ adjustStepMinutes: m })}
        />
        <NumberField label="Break" value={settings.breakMinutes} {...SETTING_LIMITS.breakMinutes} onCommit={(m) => set({ breakMinutes: m })} />
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
          hint="A short burst when you tick a priority, finish the day, reach the work week or plan the next day."
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
          <button className="btn btn-ghost" onClick={() => set({ layout: DEFAULT_SETTINGS.layout })}>
            Reset to default
          </button>
        </div>
      </Section>
    </>
  );
}
