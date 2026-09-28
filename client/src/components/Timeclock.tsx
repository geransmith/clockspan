import { useState } from 'react';
import { useBecameTrue, useCelebration } from '../hooks/useCelebration';
import { useSettings } from '../hooks/useSettings';
import { useTimeFormat } from '../hooks/useTimeFormat';
import { unlockAudio } from '../lib/alerts';
import { pickCelebration } from '../lib/celebrate';
import { floorToMinute, formatDuration, formatDurationCeil } from '../lib/format';
import {
  addPunchPair,
  clockOutPosition,
  daySettings,
  extraPairs,
  nextPunchPosition,
  removePunchPair,
  secondMealApplies,
  type ExtraPair,
  type TimeclockResult,
} from '../lib/timeclock';
import { SETTING_LIMITS } from '../../../shared/settings.js';
import type { WeekHours } from '../lib/week';
import type { Punch } from '../types';
import { Burst } from './Burst';
import { DurationField } from './DurationField';
import { Plus, Trash, X } from './Icons';
import { Tile } from './Tile';
import { TimeField } from './TimeField';

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
  /** The day's logged focus: with the meal rules off there's no lunch deadline, so that tile shows this. */
  focus: { seconds: number; sessions: number };
  onChange: (punches: Punch[]) => void;
  onOvertimeChange: (approved: boolean) => void;
  onWorkMinutesChange: (minutes: number | null) => void;
  /** Focus entered or left the punch rows: the app holds alarms while a time is being typed. */
  onEditingChange?: (editing: boolean) => void;
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
  // A day flagged while the feature was on only counts while it is still on.
  const otOn = otFeature && overtimeApproved;

  const setAt = (position: number, at: number | null) => {
    // A punch is typed or tapped: the gesture iOS wants before any sound, so the day-complete
    // clip (played after the save comes back) and the day's alarms can be heard.
    unlockAudio();
    onChange(punches.map((p) => (p.position === position ? { ...p, at } : p)));
  };
  const addPair = () => onChange(addPunchPair(punches));
  const removePair = (outPosition: number) => onChange(removePunchPair(punches, outPosition));

  // The tile turns amber once the first (largest) warning lead is reached.
  const firstLead = (id: 'lunchBy' | 'clockOut') => {
    const a = settings.alarms[id];
    return a.enabled && a.leadMinutes.length ? Math.max(...a.leadMinutes) * 60 : 15 * 60;
  };

  // ----- tiles -----
  let lunchTone = '';
  let lunchSub = 'Clock in to see your deadline';
  if (tc.lunchBy != null) {
    const secs = (tc.lunchBy - now) / 1000;
    if (tc.lunchStatus === 'taken') {
      lunchTone = 'tile--ok';
      lunchSub = `Taken at ${formatTime(tc.lunchOut!)}`;
    } else if (tc.lunchStatus === 'not-needed') {
      lunchSub = 'Not needed today';
    } else if (tc.state === 'done') {
      lunchSub = 'Not taken';
    } else if (tc.lunchStatus === 'overdue') {
      lunchTone = 'tile--danger';
      lunchSub = `Overdue by ${formatDurationCeil(-secs)}`;
    } else {
      lunchTone = secs <= firstLead('lunchBy') ? 'tile--warn' : '';
      lunchSub = `In ${formatDurationCeil(secs)}`;
    }
  }

  let outTone = '';
  let outSub = 'Clock in to see your end time';
  if (tc.clockOutAt != null) {
    const secs = (tc.clockOutAt - now) / 1000;
    if (tc.clockOutStatus === 'done') {
      outTone = 'tile--accent';
      outSub = 'Day complete';
    } else if (tc.clockOutStatus === 'over') {
      // Past the day's length is overtime only where overtime applies; otherwise it's just later.
      outTone = otOn || !otFeature ? 'tile--accent' : 'tile--danger';
      outSub = otFeature
        ? `Over by ${formatDurationCeil(tc.overSeconds)}${otOn ? ' · OT approved' : ''}`
        : `${formatDurationCeil(tc.overSeconds)} past your day`;
    } else {
      outTone = !otOn && secs <= firstLead('clockOut') ? 'tile--warn' : '';
      outSub = !isToday ? 'No clock-out recorded' : tc.state === 'working' ? `In ${formatDurationCeil(secs)}` : 'If you return now';
    }
  }

  const workedSub =
    tc.clockIn == null
      ? `${formatDuration(daySet.workMinutes * 60)} day`
      : tc.overSeconds > 0
        ? `${formatDuration(tc.overSeconds)} over target`
        : tc.state === 'done'
          ? `${formatDurationCeil(tc.remainingSeconds)} under target`
          : `${formatDurationCeil(tc.remainingSeconds)} to go`;

  const celebration = tc.state === 'done' && tc.clockOutAt != null ? pickCelebration(tc.clockOutAt) : null;
  // The burst and the sound mark the day *becoming* done while the card is open, not a day
  // that already was when it mounted (the sheet keys this card by date); the same clock-out
  // set again still counts. The burst flies from the notice.
  const { anchor: noticeRef, burst: dayBurst } = useCelebration<HTMLDivElement>(useBecameTrue(celebration != null), 'dayDone');
  // The same for the week's target, on today's sheet: the clock running past it, or a punch
  // that gets it there. Unknown until the settings are in, or a longer saved week than the
  // default would read as the target just met.
  const weekShown = settings.trackHours && week != null && week.targetSeconds > 0;
  const { anchor: weekRef, burst: weekBurst } = useCelebration<HTMLParagraphElement>(
    useBecameTrue(loaded && isToday && weekShown ? week.met : null),
    'weekDone',
  );
  const secondMeal = secondMealApplies(tc, daySet, otOn) && tc.secondMealBy != null ? tc.secondMealBy : null;

  // ----- rows -----
  const byPos = new Map(punches.map((p) => [p.position, p]));
  const pairs = extraPairs(punches);
  const before = pairs.filter((p) => p.beforeLunch);
  const after = pairs.filter((p) => !p.beforeLunch);
  const clockOutPos = clockOutPosition(punches);

  // A punch after the clock-in is expected to come after it; the time field's AM/PM guess uses that.
  const clockInAt = byPos.get(0)?.at ?? null;
  // Today, until the day is done, the next empty row's Now is the filled button: one obvious tap.
  const nextPos = isToday && tc.state !== 'done' ? nextPunchPosition(punches) : null;
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
      <div className="tiles">
        {!settings.mealRules ? (
          <Tile
            label="Focused"
            value={formatDuration(focus.seconds)}
            sub={focus.sessions === 0 ? 'No sessions yet' : `${focus.sessions} ${focus.sessions === 1 ? 'session' : 'sessions'}`}
            tone=""
          />
        ) : (
          <Tile label="Lunch by" value={tc.lunchBy != null ? formatTime(tc.lunchBy) : '—'} sub={lunchSub} tone={lunchTone} />
        )}
        <Tile label="Worked" value={formatDuration(tc.workedSeconds)} sub={workedSub} tone={tc.clockIn != null && tc.state === 'working' ? 'tile--live' : ''} />
        <Tile label="Clock out at" value={tc.clockOutAt != null ? formatTime(tc.clockOutAt) : '—'} sub={outSub} tone={outTone} />
      </div>

      {celebration && (
        <div className="notice notice--celebrate" role="status" ref={noticeRef}>
          <span key={tc.clockOutAt} className="celebrate-emoji" aria-hidden="true">
            {celebration.emoji}
          </span>
          <span>
            <strong>Day complete.</strong> {celebration.phrase}
          </span>
        </div>
      )}

      {dayBurst && <Burst key={dayBurst.seed} seed={dayBurst.seed} anchor={dayBurst.anchor} big />}

      {secondMeal != null && (
        <p className={`timeclock-note${tc.secondMealStatus === 'overdue' ? ' timeclock-note--danger' : ''}`}>
          2nd meal period {tc.secondMealStatus === 'overdue' ? 'was due' : 'due'} by {formatTime(secondMeal)} (
          {formatDuration(settings.secondMealAfterMinutes * 60)} worked)
        </p>
      )}

      {weekShown && (
        <p className="timeclock-note week-line" ref={weekRef}>
          This week <strong>{formatDuration(week.workedSeconds)}</strong> of {formatDuration(week.targetSeconds)}
          {/* A whole minute over, or the line would read "0m over" as the target is reached. */}
          {week.workedSeconds - week.targetSeconds >= 60 && (
            <>
              {' · '}
              {formatDuration(week.workedSeconds - week.targetSeconds)} {otFeature ? 'over' : 'past'}
            </>
          )}
          {weekBurst && <Burst key={weekBurst.seed} seed={weekBurst.seed} anchor={weekBurst.anchor} />}
        </p>
      )}

      <WorkDay usual={settings.workMinutes} own={workMinutes} onChange={onWorkMinutesChange} />

      {otFeature && (
        <label className="toggle-row ot-row">
          <span className="toggle-text">
            <span>Overtime approved</span>
            <span className="muted small">
              {overtimeApproved ? 'Clock-out alarm is off for today. Meal alarms stay on.' : 'Silences the clock-out alarm for this day.'}
            </span>
          </span>
          <input
            type="checkbox"
            role="switch"
            aria-checked={overtimeApproved}
            className="switch"
            checked={overtimeApproved}
            onChange={(e) => onOvertimeChange(e.target.checked)}
          />
        </label>
      )}

      <div
        className="punches"
        onFocus={() => onEditingChange?.(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onEditingChange?.(false);
        }}
      >
        {fixedRow(0, 'Clock in')}
        {pairBlock(before, 0)}
        {fixedRow(1, 'Lunch out')}
        {fixedRow(2, 'Lunch in')}
        {pairBlock(after, before.length)}
        {clockOutPos != null && fixedRow(clockOutPos, 'Clock out')}
        <button className="btn btn-ghost punch-add" onClick={addPair}>
          <Plus />
          Add extra out / in
        </button>
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
            <button className={`chip${target === half ? ' is-on' : ''}`} onClick={() => set(half)} aria-pressed={target === half}>
              Half day · {formatDuration(half * 60)}
            </button>
            <button className={`chip${own == null ? ' is-on' : ''}`} onClick={() => onChange(null)} aria-pressed={own == null}>
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
  onSet: (at: number | null) => void;
}) {
  return (
    <div className={`punch-row punch-row--${punch.kind}${punch.at != null ? ' is-set' : ''}`}>
      <span className="punch-label">{label}</span>
      <TimeField value={punch.at} date={date} hour12={hour12} anchorAt={anchorAt} label={label} onCommit={onSet} />
      <button
        className={`btn ${next ? 'btn-primary' : 'btn-ghost'} punch-now`}
        onClick={() => onSet(floorToMinute(Date.now()))}
        disabled={!isToday}
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
