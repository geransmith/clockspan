import { useState } from 'react';
import { useBecameTrue, useCelebration } from '../hooks/useCelebration';
import { useSettings } from '../hooks/useSettings';
import { useTimeFormat } from '../hooks/useTimeFormat';
import { unlockAudio } from '../lib/alerts';
import { pickCelebration } from '../lib/celebrate';
import { DAY_COMPLETE, SECOND_MEAL_NOTE } from '../lib/copy';
import { floorToMinute, formatDuration } from '../lib/format';
import { focusTile, timeclockTiles } from '../lib/tiles';
import {
  addPunchPair,
  clockOutPosition,
  daySettings,
  extraPairs,
  lunchInPunchOrder,
  lunchRowsShown,
  nextPunchPosition,
  overtimeOn,
  removePunchPair,
  secondMealApplies,
  type ExtraPair,
  type TimeclockResult,
} from '../lib/timeclock';
import { MAX_PUNCHES, samePunches } from '../../../shared/punches.js';
import { SETTING_LIMITS } from '../../../shared/settings.js';
import type { WeekHours } from '../lib/week';
import type { Punch } from '../types';
import { Burst } from './Burst';
import { DurationField } from './DurationField';
import { Plus, Trash, X } from './Icons';
import { Tile } from './Tile';
import { TimeField } from './TimeField';
import { Toggle } from './Toggle';

interface Props {
  date: string;
  isToday: boolean;
  now: number;
  punches: Punch[];
  tc: TimeclockResult;
  overtimeApproved: boolean;
  /** This day's own work-day length; null is the usual one from the settings. */
  workMinutes: number | null;
  /** The week so far up to this day; null while loading. */
  week: WeekHours | null;
  /** The day's logged focus, for the Focused tile. */
  focus: { seconds: number; count: number };
  onChange: (punches: Punch[]) => void;
  onOvertimeChange: (approved: boolean) => void;
  onWorkMinutesChange: (minutes: number | null) => void;
  /** A punch time is being typed on today's sheet, or no longer is: the app holds today's alarms meanwhile. */
  onEditingChange: (editing: boolean) => void;
}

export function Timeclock({
  date,
  isToday,
  now,
  punches,
  tc,
  overtimeApproved,
  workMinutes,
  week,
  focus,
  onChange,
  onOvertimeChange,
  onWorkMinutesChange,
  onEditingChange,
}: Props) {
  const { settings, loaded } = useSettings();
  // The day's target and the settings its timeclock ran on (`daySettings`).
  const daySet = daySettings(settings, { workMinutes });
  const { hour12, formatTime } = useTimeFormat();
  // Overtime off (exempt, salaried work): no approval switch, and time past the day is just later.
  const otFeature = settings.overtimeApproval;
  const otOn = overtimeOn(settings, overtimeApproved);

  const setAt = (position: number, at: number | null) => {
    // A punch is typed or tapped: the gesture iOS wants before any sound, so the day-complete
    // clip (played as the change renders) and the day's alarms can be heard.
    unlockAudio();
    onChange(punches.map((p) => (p.position === position ? { ...p, at } : p)));
  };
  // The rows from before the last "Add extra out / in". Removing the pair it made while the rows
  // are still the ones it made (by value: a save's answer, or a refresh that changed something
  // else, brings a new list) undoes the Add, and the Clock out gets its time back. Once any punch
  // changes, removing a pair only drops its two rows: stepping out and changing your mind must not
  // end the day.
  const [added, setAdded] = useState<Punch[] | null>(null);
  const addPair = () => {
    setAdded(punches);
    onChange(addPunchPair(punches));
  };
  const removePair = (outPosition: number) => {
    // Removing a pair can end the day (an Add undone, or a stray Out after the Clock out gone) or
    // reach the week's target (a removed break counts as worked again), so both clips need this
    // gesture.
    unlockAudio();
    onChange(added && outPosition === added.length - 1 && samePunches(addPunchPair(added), punches) ? added : removePunchPair(punches, outPosition));
  };

  const tiles = timeclockTiles(tc, {
    now,
    isToday,
    workMinutes: daySet.workMinutes,
    alarms: settings.alarms,
    overtimeApproval: otFeature,
    overtimeApproved: otOn,
    formatTime,
  });

  const celebration = tc.state === 'done' && tc.clockOutAt != null ? pickCelebration(tc.clockOutAt) : null;
  // The burst and the sound mark the day *becoming* done while the card is open, not a day
  // that already was when it mounted (the sheet keys this card by date); the same clock-out
  // set again still counts. The burst flies from the notice. Done depends on the punches
  // and the clock, never on the settings, so their arrival never makes a moment, and this needs
  // no wait for them.
  const { anchor: noticeRef, burst: dayBurst } = useCelebration<HTMLDivElement>(useBecameTrue(celebration != null), 'dayDone');
  // The same for the week's target, on today's sheet: the clock running past it, or a punch
  // that gets it there. Unknown until the settings are in, or a shorter saved week than the
  // default would read as the target just met.
  const weekShown = settings.trackHours && week != null && week.targetSeconds > 0;
  const { anchor: weekRef, burst: weekBurst } = useCelebration<HTMLParagraphElement>(
    useBecameTrue(loaded && isToday && weekShown ? week.met : null),
    'weekDone',
  );
  // Only today's sheet plans the second meal: a past day left clocked in is judged at its end.
  const secondMeal = isToday && secondMealApplies(tc, daySet, otOn) ? tc.secondMealBy : null;

  // ----- rows -----
  const byPos = new Map(punches.map((p) => [p.position, p]));
  const pairs = extraPairs(punches);
  const before = pairs.filter((p) => p.beforeLunch);
  const after = pairs.filter((p) => !p.beforeLunch);
  const clockOutPos = clockOutPosition(punches);

  // A punch after the clock-in is expected to come after it; the time field's AM/PM guess uses that.
  const clockInAt = byPos.get(0)?.at ?? null;
  const lunchRows = lunchRowsShown(punches, settings);
  // Today, until the day is done, the next empty row's Now is the filled button: one obvious tap.
  const nextPos = isToday && tc.state !== 'done' ? nextPunchPosition(punches, lunchInPunchOrder(punches, tc, settings)) : null;
  const row = (punch: Punch, label: string) => (
    <PunchRow
      key={punch.position}
      label={label}
      punch={punch}
      date={date}
      isToday={isToday}
      hour12={hour12}
      anchorAt={punch.position === 0 ? null : clockInAt}
      next={punch.position === nextPos}
      // Only a time field on today's sheet holds today's alarms: Now, × and the pair buttons
      // save at once.
      onFocusChange={isToday ? onEditingChange : undefined}
      onSet={(at) => setAt(punch.position, at)}
    />
  );
  const fixedRow = (position: number, label: string) => {
    const p = byPos.get(position);
    return p ? row(p, label) : null;
  };
  // Pairs are numbered in display order. A pair whose Out is edited across the lunch
  // boundary re-mounts in the other block; its time is already saved by then. The remove
  // button spans both rows so it reads as "remove this pair", not "clear the Out".
  const pairBlock = (list: ExtraPair[], offset: number) =>
    list.length > 0 && (
      <div className="punch-extras">
        {list.map((pair, i) => {
          const n = offset + i + 1;
          return (
            <div key={pair.out.position} className="punch-pair">
              <div className="punch-pair-rows">
                {row(pair.out, `Out ${n}`)}
                {row(pair.in, `In ${n}`)}
              </div>
              <button
                className="btn btn-icon punch-remove"
                onClick={() => removePair(pair.out.position)}
                aria-label={`Remove Out ${n} / In ${n}`}
                title="Remove this out / in pair"
              >
                <Trash />
              </button>
            </div>
          );
        })}
      </div>
    );

  return (
    <div className="timeclock">
      <div className={settings.mealRules ? 'tiles tiles--four' : 'tiles'}>
        {settings.mealRules && <Tile label="Lunch by" {...tiles.lunch} />}
        <Tile label="Worked" {...tiles.worked} />
        <Tile label="Clock out at" {...tiles.clockOut} />
        <Tile label="Focused" {...focusTile(focus, isToday)} />
      </div>

      {/* Always there, so a screen reader hears the notice arrive: a live region has to exist first. */}
      <div role="status">
        {celebration && (
          <div className="notice notice--celebrate" ref={noticeRef}>
            <span key={tc.clockOutAt} className="celebrate-emoji" aria-hidden="true">
              {celebration.emoji}
            </span>
            <span>
              <strong>{DAY_COMPLETE}</strong> {celebration.phrase}
            </span>
          </div>
        )}
      </div>

      {dayBurst && <Burst key={dayBurst.seed} seed={dayBurst.seed} anchor={dayBurst.anchor} big />}

      {secondMeal != null && (
        <p className={`timeclock-note${tc.secondMealStatus === 'overdue' ? ' timeclock-note--danger' : ''}`}>
          {SECOND_MEAL_NOTE(tc.secondMealStatus === 'overdue', formatTime(secondMeal), formatDuration(settings.secondMealAfterMinutes * 60))}
        </p>
      )}

      {weekShown && (
        <p className="timeclock-note" ref={weekRef}>
          This week <strong>{formatDuration(week.workedSeconds)}</strong> of {formatDuration(week.targetSeconds)}
          {week.overSeconds > 0 && (
            <>
              {' · '}
              {formatDuration(week.overSeconds)} {otFeature ? 'over' : 'past'}
            </>
          )}
          {weekBurst && <Burst key={weekBurst.seed} seed={weekBurst.seed} anchor={weekBurst.anchor} />}
        </p>
      )}

      <WorkDay usual={settings.workMinutes} own={workMinutes} onChange={onWorkMinutesChange} />

      {otFeature && (
        <Toggle
          className="ot-row"
          label="Overtime approved"
          hint={
            overtimeApproved
              ? `Clock-out alarm is off for this day.${settings.mealRules ? ' Meal alarms stay on.' : ''}`
              : 'Silences the clock-out alarm for this day.'
          }
          checked={overtimeApproved}
          onChange={onOvertimeChange}
        />
      )}

      <div className="punches">
        {fixedRow(0, 'Clock in')}
        {pairBlock(before, 0)}
        {lunchRows && fixedRow(1, 'Lunch out')}
        {lunchRows && fixedRow(2, 'Lunch in')}
        {pairBlock(after, before.length)}
        {clockOutPos != null && fixedRow(clockOutPos, 'Clock out')}
        {punches.length + 2 <= MAX_PUNCHES && (
          <button className="btn btn-ghost punch-add" onClick={addPair}>
            <Plus />
            Add extra out / in
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * This day's work-day length: the usual one from the settings, or its own (a half day, a long
 * one). Folded to one line until Change; any day can be set, so a past half day counts as one
 * in History too. Setting it back to the usual length stores no override.
 */
function WorkDay({ usual, own, onChange }: { usual: number; own: number | null; onChange: (minutes: number | null) => void }) {
  const [open, setOpen] = useState(false);
  const target = own ?? usual;
  const half = Math.round(usual / 2);
  const set = (m: number) => onChange(m === usual ? null : m);
  return (
    <div className="target-row">
      <div className="setting-row">
        <span className="toggle-text">
          <span>
            Work day <strong>{formatDuration(target * 60)}</strong>
          </span>
          <span className="muted small">{own == null ? 'Your usual length.' : `This day only. Usually ${formatDuration(usual * 60)}.`}</span>
        </span>
        <button className="btn btn-ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Done' : 'Change'}
        </button>
      </div>
      {open && (
        <div className="target-edit">
          <span className="chips">
            <button className="chip" onClick={() => set(half)} aria-pressed={target === half}>
              Half day · {formatDuration(half * 60)}
            </button>
            <button className="chip" onClick={() => onChange(null)} aria-pressed={own == null}>
              Usual · {formatDuration(usual * 60)}
            </button>
          </span>
          <DurationField label="This day" minutes={target} {...SETTING_LIMITS.workMinutes} onCommit={set} />
        </div>
      )}
    </div>
  );
}

function PunchRow({
  label,
  punch,
  date,
  isToday,
  hour12,
  anchorAt,
  next,
  onFocusChange,
  onSet,
}: {
  label: string;
  punch: Punch;
  date: string;
  isToday: boolean;
  hour12: boolean;
  anchorAt: number | null;
  /** The row the next punch belongs in. */
  next: boolean;
  onFocusChange?: (focused: boolean) => void;
  onSet: (at: number | null) => void;
}) {
  return (
    <div className={`punch-row punch-row--${punch.kind}`}>
      <span className="punch-label">{label}</span>
      <TimeField value={punch.at} date={date} hour12={hour12} anchorAt={anchorAt} label={label} onCommit={onSet} onFocusChange={onFocusChange} />
      <button
        className={`btn ${next ? 'btn-primary' : 'btn-ghost'} punch-now`}
        onClick={() => onSet(floorToMinute(Date.now()))}
        disabled={!isToday}
        aria-label={`Now: ${label}`}
        title={isToday ? 'Use the current time' : 'Only available today'}
      >
        Now
      </button>
      <button className="btn btn-icon punch-clear" onClick={() => onSet(null)} disabled={punch.at == null} aria-label={`Clear ${label}`} title="Clear">
        <X />
      </button>
    </div>
  );
}
