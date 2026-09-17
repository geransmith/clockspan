import { useState } from 'react';
import { useSettings } from '../hooks/useSettings';
import { useTimer } from '../hooks/useTimer';
import { CONFIRM } from '../lib/copy';
import { formatCountdown } from '../lib/format';
import { Check, Minus, Plus, X } from './Icons';

/** Fixed to the top of the viewport whenever a timer is running, on every view. */
export function RunningTimerBar() {
  const { running, remainingSeconds, progress, adjust, finish, cancel, setLabel } = useTimer();
  const { settings } = useSettings();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  if (!running) return null;
  const step = settings.adjustStepMinutes;

  const commitLabel = () => {
    setEditing(false);
    if (draft.trim() !== running.label) void setLabel(draft.trim());
  };

  return (
    <div className="running-bar" role="status" aria-live="off">
      <div className="running-bar-inner">
        <span className="running-dot" aria-hidden="true" />
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
            {running.label || <span className="muted">Untitled session</span>}
          </button>
        )}
        <span className="running-time" aria-label="Time remaining">
          {formatCountdown(remainingSeconds)}
        </span>
        <div className="running-controls">
          <button className="btn btn-icon" onClick={() => void adjust(-step * 60)} aria-label={`Remove ${step} minutes`} title={`−${step}m`}>
            <Minus />
            <span className="btn-text">{step}m</span>
          </button>
          <button className="btn btn-icon" onClick={() => void adjust(step * 60)} aria-label={`Add ${step} minutes`} title={`+${step}m`}>
            <Plus />
            <span className="btn-text">{step}m</span>
          </button>
          <button className="btn btn-primary btn-icon" onClick={() => void finish()} title="Finish now">
            <Check />
            <span className="btn-text">Finish</span>
          </button>
          <button
            className="btn btn-icon running-cancel"
            onClick={() => {
              if (window.confirm(CONFIRM.cancelSession)) void cancel();
            }}
            aria-label="Cancel session"
            title="Cancel"
          >
            <X />
          </button>
        </div>
      </div>
      <div className="running-progress" style={{ transform: `scaleX(${progress})` }} aria-hidden="true" />
    </div>
  );
}
