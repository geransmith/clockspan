import { useState } from 'react';
import { useTimer } from '../hooks/useTimer';
import { formatCountdown } from '../lib/format';
import { LabelInput, SessionLabel } from './SessionLabel';
import { TimerControls } from './TimerControls';

/** Fixed to the top of the viewport whenever a timer is running, on every view. */
export function RunningTimerBar() {
  const { running, countdownSeconds, progress, paused, due, edit } = useTimer();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  // Set when Enter or Escape ends the edit, so focus goes back to the label; a blur leaves focus where it went.
  const [returnFocus, setReturnFocus] = useState(false);
  if (!running) return null;

  const commitLabel = () => {
    setEditing(false);
    if (draft.trim() !== running.label) void edit({ label: draft.trim() });
  };

  return (
    <div className={`running-bar${paused ? ' is-paused' : ''}${due ? ' is-due' : ''}`}>
      <div className="running-bar-inner">
        <span className="running-dot" aria-hidden="true" />
        {editing ? (
          <LabelInput
            className="running-label-input"
            value={draft}
            onChange={setDraft}
            onBlur={commitLabel}
            onSave={() => {
              setReturnFocus(true);
              commitLabel();
            }}
            onDrop={() => {
              setReturnFocus(true);
              setEditing(false);
            }}
            placeholder="What are you working on?"
          />
        ) : (
          <button
            className="running-label"
            autoFocus={returnFocus}
            onClick={() => {
              setDraft(running.label);
              setReturnFocus(false);
              setEditing(true);
            }}
            title="Edit label"
          >
            <SessionLabel label={running.label} />
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
