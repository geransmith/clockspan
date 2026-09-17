import { useState } from 'react';
import { useSettings } from '../hooks/useSettings';
import { useTimer } from '../hooks/useTimer';
import { formatCountdown, formatDuration } from '../lib/format';
import { Check, Minus, Plus, X } from './Icons';

const QUICK = [15, 25, 50];

interface Props {
  date: string;
  isToday: boolean;
}

export function FocusTimer({ date, isToday }: Props) {
  const timer = useTimer();
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (timer.running) return <Running />;

  const start = async (minutes: number) => {
    setError(null);
    try {
      await timer.start(date, minutes * 60, label.trim());
      setLabel('');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="timer timer--idle">
      <input
        className="input timer-label"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="What are you working on?"
        maxLength={200}
        disabled={!isToday}
        aria-label="Session label"
      />
      <div className="timer-quick">
        {QUICK.map((m) => (
          <button key={m} className="btn btn-quick" onClick={() => void start(m)} disabled={!isToday}>
            <span className="timer-quick-num">{m}</span>
            <span className="timer-quick-unit">min</span>
          </button>
        ))}
      </div>
      {!isToday && <p className="muted center">Timers can only be started on today's sheet.</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function Running() {
  const { running, remainingSeconds, progress, adjust, finish, cancel } = useTimer();
  const { settings } = useSettings();
  if (!running) return null;
  const step = settings.adjustStepMinutes;
  const r = 54;
  const circ = 2 * Math.PI * r;

  return (
    <div className="timer timer--running">
      <div className="ring-wrap">
        <svg className="ring" viewBox="0 0 120 120" aria-hidden="true">
          <circle className="ring-track" cx="60" cy="60" r={r} />
          <circle className="ring-fill" cx="60" cy="60" r={r} strokeDasharray={circ} strokeDashoffset={circ * (1 - progress)} />
        </svg>
        <div className="ring-center">
          <div className="countdown" role="timer" aria-live="off">
            {formatCountdown(remainingSeconds)}
          </div>
          <div className="muted small">of {formatDuration(running.plannedSeconds)}</div>
        </div>
      </div>
      <div className="timer-running-label">{running.label || <span className="muted">Untitled session</span>}</div>
      <div className="timer-controls">
        <button className="btn" onClick={() => void adjust(-step * 60)}>
          <Minus /> {step}m
        </button>
        <button className="btn" onClick={() => void adjust(step * 60)}>
          <Plus /> {step}m
        </button>
        <button className="btn btn-primary" onClick={() => void finish()}>
          <Check /> Finish
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => {
            if (window.confirm('Cancel this session? It will not be logged.')) void cancel();
          }}
        >
          <X /> Cancel
        </button>
      </div>
    </div>
  );
}
