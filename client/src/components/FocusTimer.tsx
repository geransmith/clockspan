import { useState } from 'react';
import { useSettings } from '../hooks/useSettings';
import { useTimer } from '../hooks/useTimer';
import { CONFIRM, TIMER_DUE } from '../lib/copy';
import { formatCountdown, formatDuration } from '../lib/format';
import { LIMITS, type Priority } from '../types';
import { Check, Minus, Pause, Play, Plus, X } from './Icons';

const QUICK = [15, 25, 50];

interface Props {
  date: string;
  isToday: boolean;
  priorities: Priority[];
  /** Adds a row to today's priorities and resolves to its uid. */
  onAddPriority: (text: string) => Promise<string>;
}

export function FocusTimer({ date, isToday, priorities, onAddPriority }: Props) {
  const timer = useTimer();
  const [label, setLabel] = useState('');
  const [linked, setLinked] = useState<string | null>(null);
  const [addAsPriority, setAddAsPriority] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (timer.running) return <Running />;

  // Open rows only: a done priority isn't something to start a session for.
  const open = priorities.filter((p) => p.uid && p.text.trim() && !p.done);
  const linkedStillOpen = linked != null && open.some((p) => p.uid === linked);
  const trimmed = label.trim();
  // New work typed in, not tied to a row: offer to put it on the plan as well.
  const offerAdd = isToday && trimmed !== '' && !linkedStillOpen;

  const pick = (p: Priority) => {
    if (linked === p.uid) {
      setLinked(null);
      return;
    }
    setLinked(p.uid);
    setLabel(p.text);
    setAddAsPriority(false);
  };

  const start = async (minutes: number) => {
    setError(null);
    try {
      let uid = linkedStillOpen ? linked : null;
      if (!uid && offerAdd && addAsPriority) uid = await onAddPriority(trimmed);
      await timer.start(date, minutes * 60, trimmed, uid);
      setLabel('');
      setLinked(null);
      setAddAsPriority(false);
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
        maxLength={LIMITS.sessionLabel}
        disabled={!isToday}
        aria-label="Session label"
      />
      {isToday && open.length > 0 && (
        <div className="timer-priorities">
          <span className="muted small">Working on</span>
          <span className="chips">
            {open.map((p) => (
              <button
                key={p.uid}
                className={`chip${linked === p.uid ? ' is-on' : ''}`}
                onClick={() => pick(p)}
                aria-pressed={linked === p.uid}
                title={linked === p.uid ? 'Unlink from this priority' : `Start a session for priority ${p.position}`}
              >
                <span className="chip-num">{p.position}</span>
                <span className="chip-text">{p.text}</span>
              </button>
            ))}
          </span>
        </div>
      )}
      {offerAdd && (
        <label className="inline-check timer-add-priority">
          <input type="checkbox" className="checkbox" checked={addAsPriority} onChange={(e) => setAddAsPriority(e.target.checked)} />
          <span>Also add to today's priorities</span>
        </label>
      )}
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
  const { running, remainingSeconds, progress, paused, due, overrunSeconds, adjust, pause, resume, requestFinish, cancel } = useTimer();
  const { settings } = useSettings();
  if (!running) return null;
  const step = settings.adjustStepMinutes;
  const r = 54;
  const circ = 2 * Math.PI * r;
  // Past the end the countdown goes negative; the sub-line says why.
  const subline = due ? TIMER_DUE.title : paused ? 'Paused' : `of ${formatDuration(running.plannedSeconds)}`;

  return (
    <div className={`timer timer--running${paused ? ' is-paused' : ''}${due ? ' is-due' : ''}`}>
      <div className="ring-wrap">
        <svg className="ring" viewBox="0 0 120 120" aria-hidden="true">
          <circle className="ring-track" cx="60" cy="60" r={r} />
          <circle className="ring-fill" cx="60" cy="60" r={r} strokeDasharray={circ} strokeDashoffset={circ * (1 - progress)} />
        </svg>
        <div className="ring-center">
          <div className="countdown" role="timer" aria-live="off">
            {formatCountdown(due ? -overrunSeconds : remainingSeconds)}
          </div>
          <div className="muted small">{subline}</div>
        </div>
      </div>
      <div className="timer-running-label">{running.label || <span className="muted">Untitled session</span>}</div>
      <div className="timer-controls">
        {!due && (
          <button className="btn" onClick={() => void adjust(-step * 60)}>
            <Minus /> {step}m
          </button>
        )}
        <button className="btn" onClick={() => void adjust(step * 60)}>
          <Plus /> {step}m
        </button>
        {!due &&
          (paused ? (
            <button className="btn" onClick={() => void resume()}>
              <Play /> Resume
            </button>
          ) : (
            <button className="btn" onClick={() => void pause()}>
              <Pause /> Pause
            </button>
          ))}
        <button className="btn btn-primary" onClick={requestFinish}>
          <Check /> Finish
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => {
            if (window.confirm(CONFIRM.cancelSession)) void cancel();
          }}
        >
          <X /> Cancel
        </button>
      </div>
    </div>
  );
}
