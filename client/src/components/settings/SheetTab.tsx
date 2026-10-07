import { DEFAULT_SETTINGS, SETTING_LIMITS, THEMES, TIMER_MINUTES, type Theme } from '../../../../shared/settings.js';
import { stickerReasons } from '../../lib/stickers';
import { Toggle } from '../Toggle';
import { NumberField, NumberInput, Section, SelectField, type TabProps } from './controls';

const THEME_LABELS: Record<Theme, string> = { auto: 'Automatic', light: 'Light', dark: 'Dark' };

export function SheetTab({ settings, set }: TabProps) {
  const reasons = stickerReasons(settings).map((r) => r.label.toLowerCase());
  return (
    <>
      <Section title="Appearance">
        <SelectField label="Theme" value={settings.theme} options={THEMES} labels={THEME_LABELS} onChange={(theme) => set({ theme })} />
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
          <span className="inline-controls">
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
          label="Suggest a break after each session"
          hint="After you finish a session, a banner offers a break a fifth as long, as in the Pomodoro technique (25 min earns 5). Every fourth session in a row earns a long break, a fifth of all four, up to 30 min; a 15 min gap starts the count over. The Break button offers the same."
          checked={settings.suggestBreaks}
          onChange={(v) => set({ suggestBreaks: v })}
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
          hint="A short burst when you tick a priority, finish the day, reach the work week or plan the next day."
          checked={settings.celebrations}
          onChange={(v) => set({ celebrations: v })}
        />
      </Section>
      <Section title="History">
        <Toggle
          label="Sticker chart"
          hint={`Every day on the calendar wears a sticker for each thing it did: ${reasons.join(', ')}.`}
          checked={settings.stickers}
          onChange={(v) => set({ stickers: v })}
        />
        <Toggle
          label="Show weekends"
          hint="Off hides Saturday and Sunday from the calendar and its sticker counts, and Plan tomorrow on a Friday plans Monday."
          checked={settings.showWeekends}
          onChange={(v) => set({ showWeekends: v })}
        />
      </Section>
      <Section title="Board">
        <Toggle
          label="Board page"
          hint="Adds a Board button: a page for tasks that aren't for today."
          checked={settings.board}
          onChange={(v) => set({ board: v })}
        />
      </Section>
      <Section title="Layout" hint="Use Customize on the sheet to drag cards, hide them or move them to the other column on a wide screen.">
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
