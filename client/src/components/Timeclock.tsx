import { useEffect, useRef, useState } from 'react';
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
  punchLabel,
  removePunchPair,
  secondMealApplies,
  type ExtraPair,
  type TimeclockResult,
} from '../lib/timeclock';
import { MAX_PUNCHES, punchesKey } from '../../../shared/punches.js';
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
  /** The id of the sheet's punch-order notice, which describes the punch out of place. */
  orderNotice: string;
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
  orderNotice,
}: Props) {
  const { settings, loaded } = useSettings();
  // The day's target and the settings its timeclock ran on (`daySettings`).
  const daySet = daySettings(settings, { workMinutes });
  const { hour12, formatTime } = useTimeFormat();
  // Overtime off (exempt, salaried work): no approval switch, and time past the day is just later.
  const otFeature = settings.overtimeApproval;
  const otOn = overtimeOn(settings, overtimeApproved);

  // The Clock out this card last sent, so the day turning done on a list it didn't send (a
  // refresh bringing another device's punches) isn't a moment. The time, not the whole list: the
  // store shows its merge of a save, where another device's change to another row can stand.
  const [sentOut, setSentOut] = useState<number | null>();
  const send = (list: Punch[]) => {
    setSentOut(clockOutAtOf(list));
    onChange(list);
  };
  const setAt = (position: number, at: number | null) => {
    // A punch is typed or tapped: the gesture iOS wants before any sound, so the day-complete
    // clip (played as the change renders) and the day's alarms can be heard.
    unlockAudio();
    send(punches.map((p) => (p.position === position ? { ...p, at } : p)));
  };
  // The rows from before the last "Add Extra Out / In". Removing the pair it made while the rows
  // are still the ones it made (by value: a save's answer, or a refresh that changed something
  // else, brings a new list) undoes the Add, and the Clock out gets its time back. Once any punch
  // changes, removing a pair only drops its two rows: stepping out and changing your mind must not
  // end the day. The rows live in this card's state, so a remount (a reload, another date, the
  // first Customize, a move to the other column, the sheet switching between one list and two)
  // ends the undo: the stored rows can't tell an Add from an Out typed later.
  const [added, setAdded] = useState<Punch[] | null>(null);
  // A pair button that goes with its press hands the focus on once its target shows (the new list
  // can come with the tap or after it): Remove to Add Extra Out / In, and an Add that reaches the
  // row cap, which takes its own button away, to the new pair's Remove, which undoes it. Never to
  // a time field, which would hold today's alarms.
  const punchBox = useRef<HTMLDivElement>(null);
  const refocus = useRef<string | null>(null);
  useEffect(() => {
    const el = refocus.current ? punchBox.current?.querySelector<HTMLElement>(refocus.current) : null;
    if (!el) return;
    refocus.current = null;
    el.focus();
  });
  const addPair = () => {
    const next = addPunchPair(punches);
    setAdded(punches);
    // The new pair's Out is the old Clock out row.
    if (next.length + 2 > MAX_PUNCHES) refocus.current = `.punch-remove[data-out="${punches.length - 1}"]`;
    send(next);
  };
  // The pair being typed in keeps the block it had when the focus came in: a time on its way
  // (10:3 of 10:30) can sit on the other side of lunch, and a move remounts the fields.
  const [typing, setTyping] = useState<{ out: number; before: boolean } | null>(null);
  const removePair = (outPosition: number) => {
    // Removing a pair can end the day (an Add undone, or a stray Out after the Clock out gone) or
    // reach the week's target (a removed break counts as worked again), so both clips need this
    // gesture.
    unlockAudio();
    setTyping(null);
    refocus.current = '.punch-add';
    send(added && outPosition === added.length - 1 && punchesKey(addPunchPair(added)) === punchesKey(punches) ? added : removePunchPair(punches, outPosition));
  };

  const tiles = timeclockTiles(tc, {
    now,
    isToday,
    alarms: settings.alarms,
    overtimeApproval: otFeature,
    overtimeApproved: otOn,
    formatTime,
  });

  const celebration = tc.state === 'done' && tc.clockOutAt != null ? pickCelebration(tc.clockOutAt) : null;
  // Punches that changed since the last render to a list this card didn't send: that render is
  // "not known" to the celebration, and the next one starts from there.
  const key = punchesKey(punches);
  const [seenKey, setSeenKey] = useState(key);
  const fromElsewhere = key !== seenKey && clockOutAtOf(punches) !== sentOut;
  if (key !== seenKey) {
    setSeenKey(key);
    if (fromElsewhere) setSentOut(undefined);
  }
  // The burst and the sound mark the day *becoming* done while the card is open, through this
  // card's punches or the clock reaching a Clock out typed ahead: not a day that already was
  // when it mounted (the sheet keys this card by date), nor one another device's punches finish.
  // The same clock-out set again still counts. The burst flies from the notice. Done depends on
  // the punches and the clock, never on the settings, so their arrival never makes a moment, and
  // this needs no wait for them.
  const { anchor: noticeRef, burst: dayBurst } = useCelebration<HTMLDivElement>(useBecameTrue(fromElsewhere ? null : celebration != null), 'dayDone');
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
  const pairs = extraPairs(punches).map((p) => (p.out.position === typing?.out ? { ...p, beforeLunch: typing.before } : p));
  const before = pairs.filter((p) => p.beforeLunch);
  const after = pairs.filter((p) => !p.beforeLunch);
  const clockOutPos = clockOutPosition(punches);

  const lunchRows = lunchRowsShown(punches, settings);
  // Today, until the day is done, the next empty row's Now is the filled button: one obvious tap.
  const nextPos = isToday && tc.state !== 'done' ? nextPunchPosition(punches, lunchInPunchOrder(punches, tc, settings)) : null;
  const name = (position: number) => punchLabel(punches, position, pairs);
  const row = (punch: Punch, label: string) => (
    <PunchRow
      key={punch.position}
      label={label}
      punch={punch}
      date={date}
      isToday={isToday}
      hour12={hour12}
      // A punch after the clock-in is expected to come after it; the time field's AM/PM guess uses that.
      anchorAt={punch.position === 0 ? null : tc.clockIn}
      next={punch.position === nextPos}
      errorId={punch.position === tc.outOfOrder?.position ? orderNotice : undefined}
      // Only a time field on today's sheet holds today's alarms: Now, × and the pair buttons
      // save at once.
      onFocusChange={isToday ? onEditingChange : undefined}
      onSet={(at) => setAt(punch.position, at)}
    />
  );
  const fixedRow = (position: number) => {
    const p = byPos.get(position);
    return p ? row(p, name(position)) : null;
  };
  // Pairs are numbered in display order. A pair whose Out was edited across the lunch boundary
  // moves to the other block once the focus leaves it. The remove button spans both rows so it
  // reads as "remove this pair", not "clear the Out".
  const pairBlock = (list: ExtraPair[]) =>
    list.length > 0 && (
      <div className="punch-extras">
        {list.map((pair) => {
          const [out, back] = [name(pair.out.position), name(pair.in.position)];
          return (
            <div
              key={pair.out.position}
              className="punch-pair"
              onFocus={() => setTyping({ out: pair.out.position, before: pair.beforeLunch })}
              onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setTyping(null)}
            >
              <div className="punch-pair-rows">
                {row(pair.out, out)}
                {row(pair.in, back)}
              </div>
              <button
                className="btn btn-icon punch-remove"
                data-out={pair.out.position}
                onClick={() => removePair(pair.out.position)}
                aria-label={`Remove ${out} / ${back}`}
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
        {settings.mealRules && <Tile label="Lunch By" {...tiles.lunch} />}
        <Tile label="Worked" {...tiles.worked} />
        {/* A done day's pill says so; the board's clock bar, with no pill, keeps "Day complete". */}
        <Tile label="Clock Out At" {...tiles.clockOut} sub={tc.state === 'done' ? '' : tiles.clockOut.sub} />
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

      <Burst at={dayBurst} big />

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
          <Burst at={weekBurst} />
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

      <div className="punches" ref={punchBox}>
        {fixedRow(0)}
        {pairBlock(before)}
        {lunchRows && fixedRow(1)}
        {lunchRows && fixedRow(2)}
        {pairBlock(after)}
        {clockOutPos != null && fixedRow(clockOutPos)}
        {punches.length + 2 <= MAX_PUNCHES && (
          <button className="btn btn-ghost punch-add" onClick={addPair}>
            <Plus />
            Add Extra Out / In
          </button>
        )}
      </div>
    </div>
  );
}

/** The Clock out row's time; null while it is empty or the list has none. */
function clockOutAtOf(punches: Punch[]): number | null {
  const pos = clockOutPosition(punches);
  return punches.find((p) => p.position === pos)?.at ?? null;
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
              Half Day · {formatDuration(half * 60)}
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
  errorId,
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
  /** See `TimeField.errorId`. */
  errorId?: string;
  onFocusChange?: (focused: boolean) => void;
  onSet: (at: number | null) => void;
}) {
  return (
    <div className={`punch-row punch-row--${punch.kind}`}>
      <span className="punch-label">{label}</span>
      <TimeField
        value={punch.at}
        date={date}
        hour12={hour12}
        anchorAt={anchorAt}
        label={label}
        onCommit={onSet}
        onFocusChange={onFocusChange}
        errorId={errorId}
      />
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
