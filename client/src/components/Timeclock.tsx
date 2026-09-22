import { useEffect, useRef, useState } from 'react';
import { useLatest } from '../hooks/useLatest';
import { useSettings } from '../hooks/useSettings';
import { useTimeFormat } from '../hooks/useTimeFormat';
import { playSound, unlockAudio } from '../lib/alerts';
import { pickCelebration } from '../lib/celebrate';
import { formatDuration, formatDurationCeil, roundToMinute } from '../lib/format';
import { clockOutPosition, extraPairs, kindForPosition, secondMealApplies, type ExtraPair, type TimeclockResult } from '../lib/timeclock';
import type { Punch } from '../types';
import { Burst, BURST_MS } from './Burst';
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
  onChange: (punches: Punch[]) => void;
  onOvertimeChange: (approved: boolean) => void;
  /** Focus entered or left the punch rows: the app holds alarms while a time is being typed. */
  onEditingChange?: (editing: boolean) => void;
}

export function Timeclock({ date, isToday, now, punches, tc, overtimeApproved, onChange, onOvertimeChange, onEditingChange }: Props) {
  const { settings } = useSettings();
  const { hour12, formatTime } = useTimeFormat();
  // A day flagged while the feature was on only counts while it is still on.
  const otOn = settings.overtimeApproval && overtimeApproved;

  const setAt = (position: number, at: number | null) => {
    // A punch is typed or tapped: the gesture iOS wants before any sound, so the day-complete
    // clip (played after the save comes back) and the day's alarms can be heard.
    unlockAudio();
    onChange(punches.map((p) => (p.position === position ? { ...p, at } : p)));
  };
  // Appending two rows turns the current Clock out into the new pair's Out (keeping its time)
  // and adds an empty In and a fresh Clock out: "I clocked out, then came back".
  const addPair = () => {
    const n = punches.length;
    onChange([...punches, { position: n, kind: kindForPosition(n), at: null }, { position: n + 1, kind: kindForPosition(n + 1), at: null }]);
  };
  const removePair = (outPosition: number) => {
    const out = punches.find((p) => p.position === outPosition);
    const back = punches.find((p) => p.position === outPosition + 1);
    const clockOutPos = clockOutPosition(punches);
    let kept = punches.filter((p) => p.position !== outPosition && p.position !== outPosition + 1);
    // A pair added by mistake right after clocking out has the clock-out time in its Out and
    // nothing in its In; removing it hands that time back to the Clock out row.
    if (out?.at != null && back?.at == null && clockOutPos != null && kept.find((p) => p.position === clockOutPos)?.at == null) {
      kept = kept.map((p) => (p.position === clockOutPos ? { ...p, at: out.at } : p));
    }
    onChange(kept.map((p, i) => ({ ...p, position: i, kind: kindForPosition(i) })));
  };

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
      outTone = otOn ? 'tile--accent' : 'tile--danger';
      outSub = `Over by ${formatDurationCeil(tc.overSeconds)}${otOn ? ' · OT approved' : ''}`;
    } else {
      outTone = !otOn && secs <= firstLead('clockOut') ? 'tile--warn' : '';
      outSub = !isToday ? 'No clock-out recorded' : tc.state === 'working' ? `In ${formatDurationCeil(secs)}` : 'If you return now';
    }
  }

  const workedSub =
    tc.clockIn == null
      ? `${formatDuration(settings.workMinutes * 60)} day`
      : tc.overSeconds > 0
        ? `${formatDuration(tc.overSeconds)} over target`
        : tc.state === 'done'
          ? `${formatDurationCeil(tc.remainingSeconds)} under target`
          : `${formatDurationCeil(tc.remainingSeconds)} to go`;

  const celebration = tc.state === 'done' && tc.clockOutAt != null ? pickCelebration(tc.clockOutAt) : null;
  // The burst and the sound mark the day *becoming* done while the card is open, not a day
  // that already was when it mounted (the sheet keys this card by date). "Adjust state while
  // rendering"; the sound is a side effect, so the moment is recorded (a fresh object each
  // time, so the same clock-out set again still counts) and played from an effect.
  const doneNow = celebration != null;
  const [wasDone, setWasDone] = useState(doneNow);
  const [burstSeed, setBurstSeed] = useState<number | null>(null);
  const [celebrate, setCelebrate] = useState<{ at: number | null } | null>(null);
  if (doneNow !== wasDone) {
    setWasDone(doneNow);
    if (doneNow) {
      setCelebrate({ at: tc.clockOutAt });
      if (settings.celebrations) setBurstSeed(tc.clockOutAt);
    }
  }
  const latest = useLatest(settings);
  useEffect(() => {
    if (!celebrate) return;
    const { sound, sounds } = latest.current;
    if (sound) playSound(sounds.dayDone);
  }, [celebrate, latest]);
  const notice = useRef<HTMLDivElement>(null);
  const [burstAnchor, setBurstAnchor] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (burstSeed == null) return;
    // The notice has to be on screen before it can be measured.
    setBurstAnchor(notice.current?.getBoundingClientRect() ?? null);
    const id = window.setTimeout(() => {
      setBurstSeed(null);
      setBurstAnchor(null);
    }, BURST_MS);
    return () => window.clearTimeout(id);
  }, [burstSeed]);
  const secondMeal = secondMealApplies(tc, settings, otOn) && tc.secondMealBy != null ? tc.secondMealBy : null;

  // ----- rows -----
  const byPos = new Map(punches.map((p) => [p.position, p]));
  const pairs = extraPairs(punches);
  const before = pairs.filter((p) => p.beforeLunch);
  const after = pairs.filter((p) => !p.beforeLunch);
  const clockOutPos = clockOutPosition(punches);

  // A punch after the clock-in is expected to come after it; the time field's AM/PM guess uses that.
  const clockInAt = byPos.get(0)?.at ?? null;
  const row = (punch: Punch, label: string) => (
    <PunchRow
      key={punch.position}
      label={label}
      punch={punch}
      date={date}
      isToday={isToday}
      hour12={hour12}
      anchorAt={punch.position === 0 ? null : clockInAt}
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
        <Tile label="Lunch by" value={tc.lunchBy != null ? formatTime(tc.lunchBy) : '—'} sub={lunchSub} tone={lunchTone} />
        <Tile label="Worked" value={formatDuration(tc.workedSeconds)} sub={workedSub} tone={tc.clockIn != null && tc.state === 'working' ? 'tile--live' : ''} />
        <Tile label="Clock out at" value={tc.clockOutAt != null ? formatTime(tc.clockOutAt) : '—'} sub={outSub} tone={outTone} />
      </div>

      {celebration && (
        <div className="notice notice--celebrate" role="status" ref={notice}>
          <span key={tc.clockOutAt} className="celebrate-emoji" aria-hidden="true">
            {celebration.emoji}
          </span>
          <span>
            <strong>Day complete.</strong> {celebration.phrase}
          </span>
        </div>
      )}

      {burstSeed != null && burstAnchor && <Burst key={burstSeed} seed={burstSeed} anchor={burstAnchor} big />}

      {secondMeal != null && (
        <p className={`timeclock-note${tc.secondMealStatus === 'overdue' ? ' timeclock-note--danger' : ''}`}>
          2nd meal period {tc.secondMealStatus === 'overdue' ? 'was due' : 'due'} by {formatTime(secondMeal)} (
          {formatDuration(settings.secondMealAfterMinutes * 60)} worked)
        </p>
      )}

      {settings.overtimeApproval && (
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

function PunchRow({
  label,
  punch,
  date,
  isToday,
  hour12,
  anchorAt,
  onSet,
}: {
  label: string;
  punch: Punch;
  date: string;
  isToday: boolean;
  hour12: boolean;
  anchorAt: number | null;
  onSet: (at: number | null) => void;
}) {
  return (
    <div className={`punch-row punch-row--${punch.kind}${punch.at != null ? ' is-set' : ''}`}>
      <span className="punch-label">{label}</span>
      <TimeField value={punch.at} date={date} hour12={hour12} anchorAt={anchorAt} label={label} onCommit={onSet} />
      <button
        className="btn btn-ghost punch-now"
        onClick={() => onSet(roundToMinute(Date.now()))}
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
