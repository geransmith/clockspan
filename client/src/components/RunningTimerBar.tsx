import { useState } from 'react';
import { useSettings } from '../hooks/useSettings';
import { useTimer } from '../hooks/useTimer';
import { CONFIRM } from '../lib/copy';
import { LIMITS } from '../types';
import { formatCountdown } from '../lib/format';
import { Check, Minus, Pause, Play, Plus, X } from './Icons';

/** Fixed to the top of the viewport whenever a timer is running, on every view. */
export function RunningTimerBar() {
  const { running, remainingSeconds, overrunSeconds, progress, paused, due, adjust, pause, resume, requestFinish, cancel, setLabel } = useTimer();
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
            {running.label || <span className="muted">Untitled session</span>}
          </button>
        )}
        <span className="running-time" aria-label={due ? 'Time over' : 'Time remaining'}>
          {formatCountdown(due ? -overrunSeconds : remainingSeconds)}
        </span>
        <div className="running-controls">
          {!due && (
            <button className="btn btn-icon" onClick={() => void adjust(-step * 60)} aria-label={`Remove ${step} minutes`} title={`−${step}m`}>
              <Minus />
              <span className="btn-text">{step}m</span>
            </button>
          )}
          <button className="btn btn-icon" onClick={() => void adjust(step * 60)} aria-label={`Add ${step} minutes`} title={`+${step}m`}>
            <Plus />
            <span className="btn-text">{step}m</span>
          </button>
          {!due &&
            (paused ? (
              <button className="btn btn-icon" onClick={() => void resume()} aria-label="Resume timer" title="Resume">
                <Play />
                <span className="btn-text">Resume</span>
              </button>
            ) : (
              <button className="btn btn-icon" onClick={() => void pause()} aria-label="Pause timer" title="Pause">
                <Pause />
                <span className="btn-text">Pause</span>
              </button>
            ))}
          <button className="btn btn-primary btn-icon" onClick={requestFinish} title="Finish now">
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
