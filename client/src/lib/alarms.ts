import type { AlarmId, AlarmSettings, Break, CardId, Day, Settings } from '../types';
import { MINUTE_MS } from '../../../shared/dates.js';
import { lastBreakEnd, runningBreak } from './breaks';
import { floorToMinute, formatMinutes, formatTime } from './format';
import { secondMealApplies, type TimeclockResult, type TimeclockSettings } from './timeclock';

export interface AlarmTarget {
  id: AlarmId;
  /** Epoch ms of the deadline. */
  at: number;
  /** False disables the target (e.g. lunch already taken, or clock-out still drifting). */
  armed: boolean;
}

const cardShown = (layout: Settings['layout'], id: CardId) => layout.some((l) => l.id === id && l.visible);

/** The break alarm rings this long after the last rest. */
export const NO_BREAK_MINUTES = 90;
/** The break alarm holds from this long before an armed lunch or clock-out deadline. */
export const BREAK_HOLD_MINUTES = 30;

/** What of the day besides its punches arms a target: its own switches, its breaks and a running session. */
export interface TargetDay {
  /** Silences the clock-out target only. */
  overtimeApproved: boolean;
  /** Today's retrospective has been marked reviewed. */
  retroDone: boolean;
  /** Today's breaks, by start. */
  breaks: readonly Break[];
  /** A session runs on today's sheet, paused or due included. */
  timerRunning: boolean;
}

/**
 * Today's targets and when each is armed. Lunch is armed until it is taken or the day is
 * done. The end of lunch is armed while at lunch (`lunchEndsAt`), so a Lunch in never punched
 * still rings. Clock-out is only a fixed instant while working (on a break it drifts later), and
 * the retrospective shares it. Overtime approval disarms the clock-out target only: meal
 * periods are still required on an overtime day (California Labor Code §512), so lunch and
 * the second meal stay armed, and the planned end of the day is still the moment to look back.
 * With the punches out of order the timeclock reads "working" whatever happened, and an end
 * that drifts with the clock would be a new alarm every minute, so the end of the day, the
 * retrospective and the second meal wait for the punches to be fixed. Lunch stays armed: its
 * deadline comes from the clock-in and doesn't move, and a typo elsewhere must not mute the
 * meal period while the person is still working. On a day that is really over, the repeat is
 * what prompts fixing the punches. A hidden retrospective card disarms its reminder, since the
 * banner's button and Mark Reviewed are on the card. A typed Clock out moves the end earlier, never
 * later, so a day running past the planned end still warns.
 *
 * The break alarm's target is `NO_BREAK_MINUTES` after the last rest: the later of the In punch the
 * clock reached last and the end of the last break over by `now`. It moves only when a rest
 * happens, never with the clock. It is armed while working with the punches in order and no break
 * or session running, so a target passed during a timer rings once it is finished. It holds from
 * `BREAK_HOLD_MINUTES` before an armed lunch or clock-out deadline (armed, whatever their own
 * switches say) until lunch is taken, the day ends or overtime is approved.
 */
export function alarmTargets(tc: TimeclockResult, settings: TimeclockSettings & Pick<Settings, 'layout'>, day: TargetDay, now: number): AlarmTarget[] {
  const endFixed = !tc.outOfOrder && tc.state === 'working';
  const end = Math.min(tc.clockOutAt ?? 0, tc.typedClockOut ?? Infinity);
  const targets: AlarmTarget[] = [
    {
      id: 'lunchBy',
      at: tc.lunchBy ?? 0,
      armed: (tc.lunchStatus === 'upcoming' || tc.lunchStatus === 'overdue') && tc.state !== 'done',
    },
    { id: 'lunchEnd', at: tc.lunchEndsAt ?? 0, armed: tc.lunchEndsAt != null },
    { id: 'clockOut', at: end, armed: endFixed && !day.overtimeApproved },
    { id: 'secondMeal', at: tc.secondMealBy ?? 0, armed: secondMealApplies(tc, settings, day.overtimeApproved) },
    { id: 'retro', at: end, armed: endFixed && !day.retroDone && cardShown(settings.layout, 'retro') },
  ];
  const since = tc.workingSince;
  const held = targets.some((t) => (t.id === 'lunchBy' || t.id === 'clockOut') && t.armed && now >= t.at - BREAK_HOLD_MINUTES * MINUTE_MS);
  targets.push({
    id: 'noBreak',
    at: since == null ? 0 : Math.max(since, lastBreakEnd(day.breaks, now) ?? since) + NO_BREAK_MINUTES * MINUTE_MS,
    armed: endFixed && !runningBreak(day.breaks, now) && !day.timerRunning && !held,
  });
  return targets;
}

/**
 * The minute the "Not Clocked In" banner offers to clock in at (`useAlarms`): the earliest start
 * among the day's sessions and breaks, floored. Null, for no banner, unless something was logged,
 * no punch is set, the Timeclock card shows and something counts from the clock-in: the hours, or
 * an alarm that could ring.
 */
export function missedClockIn(
  day: Pick<Day, 'punches' | 'sessions' | 'breaks'>,
  settings: Pick<Settings, 'layout' | 'trackHours' | 'mealRules' | 'alarms'>,
): number | null {
  const starts = [...day.sessions, ...day.breaks].map((x) => x.startedAt);
  const { alarms } = settings;
  const counts =
    settings.trackHours ||
    alarms.clockOut.enabled ||
    alarms.noBreak.enabled ||
    (settings.mealRules && (alarms.lunchBy.enabled || alarms.lunchEnd.enabled || alarms.secondMeal.enabled)) ||
    (alarms.retro.enabled && cardShown(settings.layout, 'retro'));
  if (starts.length === 0 || day.punches.some((p) => p.at != null) || !cardShown(settings.layout, 'timeclock') || !counts) return null;
  return floorToMinute(Math.min(...starts));
}

export type AlarmKind = 'lead' | 'due' | 'overdue';

export interface AlarmEvent {
  key: string;
  id: AlarmId;
  kind: AlarmKind;
  /** Lead minutes before, or minutes past, the target. 0 for 'due'. */
  minutes: number;
  /** The instant this event was scheduled for. */
  at: number;
  target: number;
}

/**
 * Keys include the target instant (minute precision) so a target that moves — a long
 * lunch pushing clock-out later — re-arms automatically, while a reload never re-fires.
 */
export function eventKey(id: AlarmId, kind: AlarmKind, minutes: number, target: number): string {
  return `${id}:${kind}:${minutes}:${Math.round(target / MINUTE_MS)}`;
}

/** How long a banner's Snooze quiets its alarm. */
export const SNOOZE_MINUTES = 15;

/** Only a repeating alarm can be snoozed, and never the retrospective, which is no deadline. */
export function snoozable(id: AlarmId, cfg: AlarmSettings): boolean {
  return id !== 'retro' && cfg.overdueEveryMinutes > 0;
}

/** The alarms whose deadline still rings, once, during a meeting: a legal or overtime line. */
const MEETING_RINGS: readonly AlarmId[] = ['lunchBy', 'lunchEnd', 'clockOut', 'secondMeal'];

/**
 * Pure scheduler. Returns the events to fire now and the keys crossed that could come round
 * again (for a repeat, only the latest), for the caller to persist. If several thresholds for
 * one target were crossed since the last check (the phone was asleep), only the latest fires,
 * so there is no burst of chimes.
 *
 * `snoozedUntil` holds today's snoozes: when each alarm rings again, its Snooze pressed
 * `SNOOZE_MINUTES` before. A snoozable target whose deadline is at or before its press is
 * covered: until that time it fires and crosses nothing and is listed in `snoozed`, then it rings
 * once at that time and repeats a full interval apart from it. A deadline moved past the press
 * isn't covered, and rings on its own schedule.
 *
 * `inMeeting` (a meeting is on now) lets only a deadline's own ring sound (`MEETING_RINGS`),
 * crossing the warnings before it; every other event, the break alarm and the retrospective
 * included, is left uncrossed, so the latest one missed rings once the meeting ends.
 */
export function dueEvents(
  targets: AlarmTarget[],
  alarms: Record<AlarmId, AlarmSettings>,
  fired: ReadonlySet<string>,
  now: number,
  snoozedUntil: Day['snoozedUntil'] = {},
  inMeeting = false,
): { fire: AlarmEvent[]; crossed: string[]; snoozed: AlarmTarget[] } {
  const fire: AlarmEvent[] = [];
  const crossed: string[] = [];
  const snoozed: AlarmTarget[] = [];

  for (const target of targets) {
    if (!target.armed) continue;
    const cfg = alarms[target.id];
    if (!cfg.enabled) continue;
    const until = snoozedUntil[target.id];
    const covered = until != null && snoozable(target.id, cfg) && target.at <= until - SNOOZE_MINUTES * MINUTE_MS;
    if (covered && now < until) {
      snoozed.push(target);
      continue;
    }

    const event = (kind: AlarmKind, minutes: number, at: number): AlarmEvent => ({
      key: eventKey(target.id, kind, minutes, target.at),
      id: target.id,
      kind,
      minutes,
      at,
      target: target.at,
    });
    const candidates = cfg.leadMinutes.map((lead) => event('lead', lead, target.at - lead * MINUTE_MS));
    if (cfg.onDue) candidates.push(event('due', 0, target.at));
    if (cfg.overdueEveryMinutes > 0) {
      const every = cfg.overdueEveryMinutes * MINUTE_MS;
      // A snooze's own ring is k = 0, and its repeats count from it, so none lands seconds after it.
      const from = covered ? until : target.at;
      // Only the latest repeat: for a fixed target k only grows, so an earlier one never comes round again.
      const k = Math.floor((now - from) / every);
      const at = from + k * every;
      // Whole minutes past the deadline: a snooze's ring is 15 or more past any repeat before the press, so no key clashes.
      if (covered || k > 0) candidates.push(event('overdue', Math.floor((at - target.at) / MINUTE_MS), at));
    }

    const pending = candidates.filter((c) => c.at <= now && !fired.has(c.key)).sort((a, b) => a.at - b.at);
    const ring = inMeeting ? pending.filter((c) => c.kind === 'due' && MEETING_RINGS.includes(c.id)).at(-1) : pending.at(-1);
    if (!ring) continue;
    for (const c of pending) if (c.at <= ring.at) crossed.push(c.key);
    fire.push(ring);
  }

  return { fire, crossed, snoozed };
}

/**
 * What the copy needs beyond the event itself: how the deadline was derived, the clock-in
 * ("clocked in at 8:32 AM"), whether times carry AM/PM (see `resolveHour12`), and when the event
 * is shown, since a warning seen late (the phone was asleep) says the time actually left. Also the
 * Clock out typed ahead (`typedClockOut`), which the clock-out warning names when it is the target.
 */
type EventContext = Pick<TimeclockSettings, 'workMinutes' | 'lunchDeadlineMinutes' | 'lunchMinutes' | 'secondMealAfterMinutes'> & {
  clockIn: number;
  hour12: boolean;
  now: number;
  typedClockOut: number | null;
};

interface EventCopy {
  /** Which alarm, e.g. "Clock-out alarm"; the title says how long is left or past. */
  kicker: string;
  title: string;
  /** Why: the computed deadline and how it was derived. */
  body: string;
  tone: 'warn' | 'danger';
}

/** Starts the tag of every alarm banner, one per target (`ALARM_TAG + id`): a newer banner replaces its target's last one. */
export const ALARM_TAG = 'alarm:';

/** Each alarm's kicker, its name; a new `AlarmId` without one is a type error. */
const ALARM_NAMES: Record<AlarmId, string> = {
  lunchBy: 'Lunch alarm',
  lunchEnd: 'Lunch end alarm',
  clockOut: 'Clock-out alarm',
  secondMeal: 'Second meal alarm',
  retro: 'Retrospective',
  noBreak: 'Break alarm',
};

/**
 * Human copy for an event. A chime on its own just says "something happened"; the banner
 * has to answer which alarm (the kicker), how long is left or past (the title) and where the
 * deadline came from (the body).
 */
export function describeEvent(e: AlarmEvent, ctx: EventContext): EventCopy {
  const target = formatTime(e.target, ctx.hour12);
  const clockIn = formatTime(ctx.clockIn, ctx.hour12);
  const day = formatMinutes(ctx.workMinutes);
  const kicker = ALARM_NAMES[e.id];
  const mealHours = formatMinutes(ctx.secondMealAfterMinutes);
  // A warning seen after its deadline (the phone was asleep, or the clock-in was typed in late) has
  // no time left to give, so it takes the due copy; one seen late but before the deadline says how
  // long is left now.
  const kind = e.kind === 'lead' && ctx.now >= e.target ? 'due' : e.kind;
  const left = formatMinutes(Math.min(e.minutes, Math.ceil((e.target - ctx.now) / MINUTE_MS)));

  // A due event can be seen late too (the app opened after the target, with repeats off), so a
  // due body gives the target's time and never says that it is that time now.
  switch (e.id) {
    case 'retro':
      // The retrospective isn't a deadline: its target is the clock-out instant and the copy
      // stays at "warn" throughout.
      if (kind === 'lead') {
        return {
          kicker,
          title: 'Look Back Before You Clock Out',
          body: `Your day ends at ${target}. Compare what you planned with what you did while it's fresh.`,
          tone: 'warn',
        };
      }
      if (kind === 'due') {
        return {
          kicker,
          title: 'Clocking Out? Do the Retrospective First.',
          body: `You reached your ${day} at ${target}. Two minutes on what went to plan and what didn't.`,
          tone: 'warn',
        };
      }
      return {
        kicker,
        title: `Retrospective Is ${formatMinutes(e.minutes)} Overdue`,
        body: `Your day ended at ${target}. The retrospective card is on today's sheet.`,
        tone: 'warn',
      };
    case 'lunchBy':
      if (kind === 'lead') {
        return {
          kicker,
          title: `Lunch in ${left}`,
          body: `Lunch must start by ${target}, ${formatMinutes(ctx.lunchDeadlineMinutes)} after clocking in at ${clockIn}.`,
          tone: 'warn',
        };
      }
      if (kind === 'due') return { kicker, title: 'Take Lunch Now', body: `Your lunch deadline is ${target}. Punch Lunch out.`, tone: 'danger' };
      return {
        kicker,
        title: `Lunch Is ${formatMinutes(e.minutes)} Overdue`,
        body: `Your lunch deadline was ${target}. Punch Lunch out as soon as you can.`,
        tone: 'danger',
      };
    case 'lunchEnd': {
      const lunch = `Lunch out at ${formatTime(e.target - ctx.lunchMinutes * MINUTE_MS, ctx.hour12)}; lunch is ${formatMinutes(ctx.lunchMinutes)}.`;
      // Only a hand-made PUT gives it a lead: the editor has no Warn before row.
      if (kind === 'lead') return { kicker, title: `Lunch Ends in ${left}`, body: lunch, tone: 'warn' };
      if (kind === 'due') return { kicker, title: 'Lunch Is Over', body: lunch, tone: 'warn' };
      return {
        kicker,
        title: `Lunch Ended ${formatMinutes(e.minutes)} Ago`,
        body: 'Clock-out and retrospective alarms are off until Lunch in is punched.',
        tone: 'warn',
      };
    }
    case 'secondMeal':
      if (kind === 'lead') {
        return {
          kicker,
          title: `Second Meal Period in ${left}`,
          body: `Your ${mealHours} of work ends at ${target}. A second meal period is due before then.`,
          tone: 'warn',
        };
      }
      if (kind === 'due') {
        return {
          kicker,
          title: 'Take Your Second Meal Period',
          body: `You reached ${mealHours} of work at ${target}. A second meal period was due by then.`,
          tone: 'danger',
        };
      }
      return {
        kicker,
        title: `Second Meal Period Is ${formatMinutes(e.minutes)} Overdue`,
        body: `Your ${mealHours} of work ended at ${target}. Take your second meal period as soon as you can.`,
        tone: 'danger',
      };
    case 'clockOut':
      if (kind === 'lead') {
        // A day length and a clock-in don't add up to a time the user typed.
        const end = e.target === ctx.typedClockOut ? `You set your Clock out for ${target}.` : `Your ${day} day ends at ${target} (clocked in ${clockIn}).`;
        return {
          kicker,
          title: `Clock Out in ${left}`,
          body: `${end} Start wrapping up.`,
          tone: 'warn',
        };
      }
      if (kind === 'due') {
        return { kicker, title: 'Time to Clock Out', body: `You reached your ${day} for today at ${target}. Punch out now.`, tone: 'danger' };
      }
      return {
        kicker,
        // The noun takes the hyphen, as the alarm's name does; "Clock Out Is" would read as the verb.
        title: `Clock-Out Is ${formatMinutes(e.minutes)} Overdue`,
        body: `Your day ended at ${target}. You're working past your ${day} target.`,
        tone: 'danger',
      };
    case 'noBreak': {
      // Counted to now, not to the event, so a banner raised late (a timer ran past the target) says the real time.
      const since = e.target - NO_BREAK_MINUTES * MINUTE_MS;
      return {
        kicker,
        title: `${formatMinutes(Math.floor((ctx.now - since) / MINUTE_MS))} Without a Break`,
        body: `Working since ${formatTime(since, ctx.hour12)}.`,
        tone: 'warn',
      };
    }
  }
}

/**
 * Each snoozable alarm's overdue title in sentence case, from whole minutes past its deadline; under
 * one minute, its due title. A new alarm without a line is a type error. The break alarm counts from
 * the last rest, as its title does.
 */
const SNOOZE_LINES: Record<Exclude<AlarmId, 'retro'>, (past: number) => string> = {
  lunchBy: (past) => (past > 0 ? `Lunch is ${formatMinutes(past)} overdue.` : 'Take lunch now.'),
  lunchEnd: (past) => (past > 0 ? `Lunch ended ${formatMinutes(past)} ago.` : 'Lunch is over.'),
  clockOut: (past) => (past > 0 ? `Clock-out is ${formatMinutes(past)} overdue.` : 'Time to clock out.'),
  secondMeal: (past) => (past > 0 ? `Second meal period is ${formatMinutes(past)} overdue.` : 'Take your second meal period.'),
  noBreak: (past) => `${formatMinutes(NO_BREAK_MINUTES + past)} without a break.`,
};

/** The quiet banner a snoozed alarm shows in place of its own until `until`, counted at `ctx.now`. */
export function describeSnooze(target: AlarmTarget, until: number, ctx: Pick<EventContext, 'hour12' | 'now'>): { kicker: string; title: string; body: string } {
  const time = formatTime(until, ctx.hour12);
  // `dueEvents` never lists the retrospective as snoozed.
  const line = SNOOZE_LINES[target.id as Exclude<AlarmId, 'retro'>](Math.floor((ctx.now - target.at) / MINUTE_MS));
  return { kicker: ALARM_NAMES[target.id], title: `Snoozed Until ${time}`, body: `${line} It rings again at ${time}.` };
}
