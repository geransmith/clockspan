import { useState } from 'react';
import { useTimer } from '../hooks/useTimer';
import { UNTITLED_SESSION } from '../lib/copy';
import { LIMITS } from '../types';
import { formatCountdown } from '../lib/format';
import { TimerControls } from './TimerControls';

/** Fixed to the top of the viewport whenever a timer is running, on every view. */
export function RunningTimerBar() {
  const { running, remainingSeconds, overrunSeconds, progress, paused, due, setLabel } = useTimer();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  if (!running) return null;

  const commitLabel = () => {
    setEditing(false);
    if (draft.trim() !== running.label) void setLabel(draft.trim());
  };

  return (
    <div className={`running-bar${due ? ' is-due' : ''}`} role="status" aria-live="off">
      <div className="running-bar-inner">
        <span className={`running-dot${paused ? ' is-paused' : ''}${due ? ' is-due' : ''}`} aria-hidden="true" />
        {editing ? (
          <input
            className="input running-label-input"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitLabel}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitLabel();
              if (e.key === 'Escape') setEditing(false);
            }}
            placeholder="What are you working on?"
            maxLength={LIMITS.sessionLabel}
            aria-label="Session label"
          />
        ) : (
          <button
            className="running-label"
            onClick={() => {
              setDraft(running.label);
              setEditing(true);
            }}
            title="Edit label"
          >
            {running.label || <span className="muted">{UNTITLED_SESSION}</span>}
          </button>
        )}
        <span className="running-time" aria-label={due ? 'Time over' : 'Time remaining'}>
          {formatCountdown(due ? -overrunSeconds : remainingSeconds)}
        </span>
        <TimerControls compact />
      </div>
      <div className="running-progress" style={{ transform: `scaleX(${progress})` }} aria-hidden="true" />
    </div>
  );
}
