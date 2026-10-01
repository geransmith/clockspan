import { useState } from 'react';
import { useTimer } from '../hooks/useTimer';
import { UNTITLED_SESSION } from '../lib/copy';
import { LIMITS } from '../types';
import { formatCountdown } from '../lib/format';
import { TimerControls } from './TimerControls';

/** Fixed to the top of the viewport whenever a timer is running, on every view. */
export function RunningTimerBar() {
  const { running, countdownSeconds, progress, paused, due, edit } = useTimer();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  if (!running) return null;

  const commitLabel = () => {
    setEditing(false);
    if (draft.trim() !== running.label) void edit({ label: draft.trim() });
  };

  return (
    <div className={`running-bar${due ? ' is-due' : ''}`}>
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
              // An input method's Enter picks a candidate and its Escape drops one: neither ends the edit.
              if (e.nativeEvent.isComposing) return;
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
        <span className="running-time" role="timer" aria-label={due ? 'Time over' : 'Time remaining'}>
          {formatCountdown(countdownSeconds)}
        </span>
        <TimerControls compact />
      </div>
      <div className="running-progress" style={{ transform: `scaleX(${progress})` }} aria-hidden="true" />
    </div>
  );
}
