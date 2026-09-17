import { useSettings } from '../hooks/useSettings';
import { formatDuration, formatDurationCeil, formatTime, fromTimeInput, roundToMinute, toTimeInput } from '../lib/format';
import { LUNCH_IN_POSITION, LUNCH_OUT_POSITION, kindForPosition, type TimeclockResult } from '../lib/timeclock';
import type { Punch } from '../types';
import { Plus, Trash, X } from './Icons';

interface Props {
  date: string;
  isToday: boolean;
  now: number;
  punches: Punch[];
  tc: TimeclockResult;
  onChange: (punches: Punch[]) => void;
}

function rowLabel(position: number): string {
  if (position === 0) return 'Clock in';
  if (position === LUNCH_OUT_POSITION) return 'Lunch out';
  if (position === LUNCH_IN_POSITION) return 'Lunch in';
  const pair = Math.floor((position - 3) / 2) + 1;
  return kindForPosition(position) === 'out' ? `Out ${pair}` : `In ${pair}`;
}

export function Timeclock({ date, isToday, now, punches, tc, onChange }: Props) {
  const { settings } = useSettings();
  const setAt = (position: number, at: number | null) => onChange(punches.map((p) => (p.position === position ? { ...p, at } : p)));
  const addPair = () => {
    const n = punches.length;
    onChange([...punches, { position: n, kind: kindForPosition(n), at: null }, { position: n + 1, kind: kindForPosition(n + 1), at: null }]);
  };
  const removePair = (outPosition: number) => {
    const kept = punches.filter((p) => p.position !== outPosition && p.position !== outPosition + 1);
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
      outTone = 'tile--danger';
      outSub = `Over by ${formatDurationCeil(tc.overSeconds)}`;
    } else {
      outTone = secs <= firstLead('clockOut') ? 'tile--warn' : '';
      outSub = !isToday ? 'No clock-out recorded' : tc.state === 'working' ? `In ${formatDurationCeil(secs)}` : 'If you return now';
    }
  }

  const workedSub =
    tc.clockIn == null
      ? `${formatDuration(settings.workMinutes * 60)} day`
      : tc.overSeconds > 0
        ? `${formatDuration(tc.overSeconds)} over target`
        : `${formatDurationCeil(tc.remainingSeconds)} to go`;

  const base = punches.slice(0, 3);
  const extras = punches.slice(3);

  return (
    <div className="timeclock">
      <div className="tiles">
        <Tile label="Lunch by" value={tc.lunchBy != null ? formatTime(tc.lunchBy) : '—'} sub={lunchSub} tone={lunchTone} />
        <Tile label="Worked" value={formatDuration(tc.workedSeconds)} sub={workedSub} tone={tc.clockIn != null && tc.state === 'working' ? 'tile--live' : ''} />
        <Tile label="Clock out at" value={tc.clockOutAt != null ? formatTime(tc.clockOutAt) : '—'} sub={outSub} tone={outTone} />
      </div>

      <div className="punches">
        {base.map((p) => (
          <PunchRow key={p.position} label={rowLabel(p.position)} punch={p} date={date} isToday={isToday} onSet={(at) => setAt(p.position, at)} />
        ))}
        {extras.length > 0 && (
          <div className="punch-extras">
            {extras.map((p) => (
              <PunchRow
                key={p.position}
                label={rowLabel(p.position)}
                punch={p}
                date={date}
                isToday={isToday}
                onSet={(at) => setAt(p.position, at)}
                onRemove={p.kind === 'out' ? () => removePair(p.position) : undefined}
              />
            ))}
          </div>
        )}
        <button className="btn btn-ghost punch-add" onClick={addPair}>
          <Plus />
          Add clock out / in
        </button>
      </div>
    </div>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: string }) {
  return (
    <div className={`tile ${tone}`}>
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      <div className="tile-sub">{sub}</div>
    </div>
  );
}

function PunchRow({
  label,
  punch,
  date,
  isToday,
  onSet,
  onRemove,
}: {
  label: string;
  punch: Punch;
  date: string;
  isToday: boolean;
  onSet: (at: number | null) => void;
  onRemove?: () => void;
}) {
  return (
    <div className={`punch-row punch-row--${punch.kind}${punch.at != null ? ' is-set' : ''}`}>
      <span className="punch-label">{label}</span>
      <input
        className="input punch-input"
        type="time"
        value={toTimeInput(punch.at)}
        onChange={(e) => onSet(fromTimeInput(date, e.target.value))}
        aria-label={`${label} time`}
      />
      <button className="btn btn-ghost punch-now" onClick={() => onSet(roundToMinute(Date.now()))} disabled={!isToday} title={isToday ? 'Use the current time' : 'Only available today'}>
        Now
      </button>
      <button className="btn btn-icon punch-clear" onClick={() => onSet(null)} disabled={punch.at == null} aria-label={`Clear ${label}`} title="Clear">
        <X />
      </button>
      {onRemove && (
        <button className="btn btn-icon punch-remove" onClick={onRemove} aria-label="Remove this out/in pair" title="Remove pair">
          <Trash />
        </button>
      )}
    </div>
  );
}
