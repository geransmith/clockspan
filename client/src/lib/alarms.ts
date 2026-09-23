import type { AlarmId, AlarmSettings } from '../types';
import { formatTime } from './format';

export interface AlarmTarget {
  id: AlarmId;
  /** Epoch ms of the deadline. */
  at: number;
  /** False disables the target (e.g. lunch already taken, or clock-out still drifting). */
  armed: boolean;
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

const MIN = 60_000;
const MAX_OVERDUE_REPEATS = 288; // 24h at 5-minute repeats

/**
 * Keys include the target instant (minute precision) so a target that moves — a long
 * lunch pushing clock-out later — re-arms automatically, while a reload never re-fires.
 */
export function eventKey(dateKey: string, id: AlarmId, kind: AlarmKind, minutes: number, target: number): string {
  return `${dateKey}:${id}:${kind}:${minutes}:${Math.round(target / MIN)}`;
}

/**
 * Pure scheduler. Returns the events to fire now and every key that has been crossed
 * (so the caller can persist them). If several thresholds for one target were crossed
 * since the last check (phone was asleep), only the latest fires — no chime burst.
 */
export function dueEvents(
  dateKey: string,
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
    if (!cfg?.enabled) continue;

    const candidates: AlarmEvent[] = [];
    for (const lead of cfg.leadMinutes) {
      candidates.push({
        key: eventKey(dateKey, target.id, 'lead', lead, target.at),
        id: target.id,
        kind: 'lead',
        minutes: lead,
        at: target.at - lead * MIN,
        target: target.at,
      });
    }
    if (cfg.onDue) {
      candidates.push({
        key: eventKey(dateKey, target.id, 'due', 0, target.at),
        id: target.id,
        kind: 'due',
        minutes: 0,
        at: target.at,
        target: target.at,
      });
    }
    if (cfg.overdueEveryMinutes > 0 && now > target.at) {
      const every = cfg.overdueEveryMinutes;
      const k = Math.min(MAX_OVERDUE_REPEATS, Math.floor((now - target.at) / (every * MIN)));
      for (let i = 1; i <= k; i++) {
        candidates.push({
          key: eventKey(dateKey, target.id, 'overdue', i * every, target.at),
          id: target.id,
          kind: 'overdue',
          minutes: i * every,
          at: target.at + i * every * MIN,
          target: target.at,
        });
      }
    }

    const pending = candidates.filter((c) => c.at <= now && !fired.has(c.key)).sort((a, b) => a.at - b.at);
    if (pending.length === 0) continue;
    for (const c of pending) crossed.push(c.key);
    fire.push(pending[pending.length - 1]!);
  }

  return { fire, crossed };
}

function fmtMinutes(m: number): string {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}h ${rest}m` : `${h}h`;
}

/** What the copy needs beyond the event itself: how the deadline was derived. */
export interface EventContext {
  /** Clock-in instant, for "clocked in at 8:32 AM". */
  clockIn: number;
  /** Write times with AM/PM (see `resolveHour12`). */
  hour12: boolean;
  /** Work-day target in minutes (settings.workMinutes). */
  workMinutes: number;
  /** Lunch deadline window in minutes (settings.lunchDeadlineMinutes). */
  lunchDeadlineMinutes: number;
  /** Hours worked after which the second meal period is due (settings.secondMealAfterMinutes). */
  secondMealAfterMinutes: number;
}

export interface EventCopy {
  /** Which alarm and which rule fired, e.g. "Clock-out alarm · 15 min warning". */
  kicker: string;
  title: string;
  /** Why: the computed deadline and how it was derived. */
  body: string;
  tone: 'warn' | 'danger';
}

/**
 * Human copy for an event. A chime on its own just says "something happened"; the banner
 * has to answer which alarm, which rule, and where the deadline came from.
 */
export function describeEvent(e: AlarmEvent, ctx: EventContext): EventCopy {
  const target = formatTime(e.target, ctx.hour12);
  const clockIn = formatTime(ctx.clockIn, ctx.hour12);
  const day = fmtMinutes(ctx.workMinutes);
  const alarm = e.id === 'lunchBy' ? 'Lunch alarm' : e.id === 'secondMeal' ? '2nd meal alarm' : e.id === 'retro' ? 'Retrospective' : 'Clock-out alarm';
  const mealHours = fmtMinutes(ctx.secondMealAfterMinutes);
  const mealWhy = `Your ${mealHours} of work ends at ${target}. California requires a second 30-minute meal period before then unless you've waived it.`;

  // The retrospective isn't a deadline: its target is the clock-out instant and the copy
  // stays at "warn" throughout.
  if (e.id === 'retro') {
    if (e.kind === 'lead') {
      return {
        kicker: `${alarm} · ${fmtMinutes(e.minutes)} before clock-out`,
        title: 'Look back before you clock out',
        body: `Your day ends at ${target}. Compare what you planned with what you did while it's fresh.`,
        tone: 'warn',
      };
    }
    if (e.kind === 'due') {
      return {
        kicker: `${alarm} · clock-out`,
        title: 'Clocking out? Do the retrospective first.',
        body: `It's ${target}. Two minutes on what went to plan and what didn't.`,
        tone: 'warn',
      };
    }
    return {
      kicker: `${alarm} · ${fmtMinutes(e.minutes)} overdue`,
      title: `Retrospective is ${fmtMinutes(e.minutes)} overdue`,
      body: `Your day ended at ${target}. The retrospective card is on today's sheet.`,
      tone: 'warn',
    };
  }

  if (e.kind === 'lead') {
    const kicker = `${alarm} · ${fmtMinutes(e.minutes)} warning`;
    if (e.id === 'lunchBy') {
      return {
        kicker,
        title: `Lunch in ${fmtMinutes(e.minutes)}`,
        body: `Lunch must start by ${target}, ${fmtMinutes(ctx.lunchDeadlineMinutes)} after clocking in at ${clockIn}.`,
        tone: 'warn',
      };
    }
    if (e.id === 'secondMeal') return { kicker, title: `Second meal break in ${fmtMinutes(e.minutes)}`, body: mealWhy, tone: 'warn' };
    return {
      kicker,
      title: `Clock out in ${fmtMinutes(e.minutes)}`,
      body: `Your ${day} day ends at ${target} (clocked in ${clockIn}). Start wrapping up.`,
      tone: 'warn',
    };
  }
  if (e.kind === 'due') {
    const kicker = `${alarm} · time's up`;
    if (e.id === 'lunchBy') return { kicker, title: 'Take lunch now', body: `Your lunch deadline is ${target}. Start your break.`, tone: 'danger' };
    if (e.id === 'secondMeal') return { kicker, title: 'Take your second meal break', body: mealWhy, tone: 'danger' };
    return { kicker, title: 'Time to clock out', body: `It's ${target}. You've worked your ${day} for today. Punch out now.`, tone: 'danger' };
  }
  const kicker = `${alarm} · ${fmtMinutes(e.minutes)} overdue`;
  if (e.id === 'lunchBy') {
    return {
      kicker,
      title: `Lunch is ${fmtMinutes(e.minutes)} overdue`,
      body: `Your lunch deadline was ${target}. Start your break as soon as you can.`,
      tone: 'danger',
    };
  }
  if (e.id === 'secondMeal') {
    return {
      kicker,
      title: `Second meal break is ${fmtMinutes(e.minutes)} overdue`,
      body: `Your ${mealHours} of work ended at ${target}. Take a 30-minute break as soon as you can.`,
      tone: 'danger',
    };
  }
  return {
    kicker,
    title: `Clock out is ${fmtMinutes(e.minutes)} overdue`,
    body: `Your day ended at ${target}. You're working past your ${day} target.`,
    tone: 'danger',
  };
}
