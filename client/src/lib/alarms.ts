import type { AlarmId, AlarmSettings } from '../types';

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

/** Human copy for an event. */
export function describeEvent(e: AlarmEvent): { title: string; body: string; tone: 'info' | 'warn' | 'danger' } {
  const what = e.id === 'lunchBy' ? 'Lunch' : 'Clock out';
  if (e.kind === 'lead') {
    return { title: `${what} in ${fmtMinutes(e.minutes)}`, body: e.id === 'lunchBy' ? 'Start wrapping up for your break.' : 'Time to land the plane.', tone: 'warn' };
  }
  if (e.kind === 'due') {
    return { title: e.id === 'lunchBy' ? 'Take lunch now' : 'Time to clock out', body: e.id === 'lunchBy' ? 'Your lunch deadline is now.' : 'You have hit your hours for today.', tone: 'danger' };
  }
  return { title: `${what} is ${fmtMinutes(e.minutes)} overdue`, body: e.id === 'lunchBy' ? 'Your lunch break is past due.' : 'You are past your clock-out time.', tone: 'danger' };
}
