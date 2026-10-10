import type { AlarmId, AlarmSettings, Settings } from '../types';
import { MINUTE_MS } from '../../../shared/dates.js';
import { formatMinutes, formatTime } from './format';
import { secondMealApplies, type TimeclockResult, type TimeclockSettings } from './timeclock';

export interface AlarmTarget {
  id: AlarmId;
  /** Epoch ms of the deadline. */
  at: number;
  /** False disables the target (e.g. lunch already taken, or clock-out still drifting). */
  armed: boolean;
}

/** The day's own switches that disarm a target. */
export interface TargetDay {
  /** Silences the clock-out target only. */
  overtimeApproved: boolean;
  /** Today's retrospective has been marked reviewed. */
  retroDone: boolean;
}

/**
 * Today's targets and when each is armed. Lunch is armed until it is taken or the day is
 * done. Clock-out is only a fixed instant while working (on a break it drifts later), and
 * the retrospective shares it. Overtime approval disarms the clock-out target only: meal
 * periods are still required on an overtime day (California Labor Code §512), so lunch and
 * the second meal stay armed, and the planned end of the day is still the moment to look back.
 * With the punches out of order the timeclock reads "working" whatever happened, and an end
 * that drifts with the clock would be a new alarm every minute, so the end of the day, the
 * retrospective and the second meal wait for the punches to be fixed. Lunch stays armed: its
 * deadline comes from the clock-in and doesn't move, and a typo elsewhere must not mute the
 * meal period while the person is still working. On a day that is really over, the repeat is
 * what prompts fixing the punches. A hidden retrospective card disarms its reminder, since the
 * banner's button and Mark Reviewed are on the card.
 */
export function alarmTargets(tc: TimeclockResult, settings: TimeclockSettings & Pick<Settings, 'layout'>, day: TargetDay): AlarmTarget[] {
  const endFixed = !tc.outOfOrder && tc.state === 'working';
  return [
    {
      id: 'lunchBy',
      at: tc.lunchBy ?? 0,
      armed: (tc.lunchStatus === 'upcoming' || tc.lunchStatus === 'overdue') && tc.state !== 'done',
    },
    { id: 'clockOut', at: tc.clockOutAt ?? 0, armed: endFixed && !day.overtimeApproved },
    { id: 'secondMeal', at: tc.secondMealBy ?? 0, armed: secondMealApplies(tc, settings, day.overtimeApproved) },
    { id: 'retro', at: tc.clockOutAt ?? 0, armed: endFixed && !day.retroDone && settings.layout.some((l) => l.id === 'retro' && l.visible) },
  ];
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

/**
 * Pure scheduler. Returns the events to fire now and the keys crossed that could come round
 * again (for a repeat, only the latest), for the caller to persist. If several thresholds for
 * one target were crossed since the last check (the phone was asleep), only the latest fires,
 * so there is no burst of chimes.
 */
export function dueEvents(
  targets: AlarmTarget[],
  alarms: Record<AlarmId, AlarmSettings>,
  fired: ReadonlySet<string>,
  now: number,
): { fire: AlarmEvent[]; crossed: string[] } {
  const fire: AlarmEvent[] = [];
  const crossed: string[] = [];

  for (const target of targets) {
    if (!target.armed) continue;
    const cfg = alarms[target.id];
    if (!cfg.enabled) continue;

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
      const every = cfg.overdueEveryMinutes;
      // Only the latest repeat: for a fixed target k only grows, so an earlier one never comes round again.
      const k = Math.floor((now - target.at) / (every * MINUTE_MS));
      if (k > 0) candidates.push(event('overdue', k * every, target.at + k * every * MINUTE_MS));
    }

    const pending = candidates.filter((c) => c.at <= now && !fired.has(c.key)).sort((a, b) => a.at - b.at);
    if (pending.length === 0) continue;
    for (const c of pending) crossed.push(c.key);
    fire.push(pending[pending.length - 1]!);
  }

  return { fire, crossed };
}

/**
 * What the copy needs beyond the event itself: how the deadline was derived, the clock-in
 * ("clocked in at 8:32 AM"), whether times carry AM/PM (see `resolveHour12`), and when the event
 * is shown, since a warning seen late (the phone was asleep) says the time actually left.
 */
export type EventContext = Pick<TimeclockSettings, 'workMinutes' | 'lunchDeadlineMinutes' | 'secondMealAfterMinutes'> & {
  clockIn: number;
  hour12: boolean;
  now: number;
};

export interface EventCopy {
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
  clockOut: 'Clock-out alarm',
  secondMeal: 'Second meal alarm',
  retro: 'Retrospective',
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
        return {
          kicker,
          title: `Clock Out in ${left}`,
          body: `Your ${day} day ends at ${target} (clocked in ${clockIn}). Start wrapping up.`,
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
  }
}
