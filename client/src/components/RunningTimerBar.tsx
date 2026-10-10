import { useLayoutEffect, useRef, useState } from 'react';
import { useTimer } from '../hooks/useTimer';
import { formatCountdown } from '../lib/format';
import type { Session } from '../types';
import { LabelInput, SessionLabel } from './SessionLabel';
import { TimerControls } from './TimerControls';

/** Under the header whenever a timer is running, on every view, and at the top of the window once it scrolls; `session` is the one running. */
export function RunningTimerBar({ session }: { session: Session }) {
  const { name, linked, countdownSeconds, progress, paused, due, edit } = useTimer();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  // Set when Enter or Escape ends the edit, so focus goes back to the label; a blur leaves focus where it went.
  const [returnFocus, setReturnFocus] = useState(false);
  // A session with a task is named by the task, and has no label to edit: a box open as the
  // session is linked (on another device) closes, unsent.
  if (editing && linked) setEditing(false);
  // Finish or Cancel takes the bar away with the focus in it: the brand, just above it, takes the
  // focus. Not until the bar has left the page, so nothing in it hears a blur: the bar is keyed by
  // the session, and when another device's session replaces this one, the label box's blur would
  // rename the new one.
  const bar = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = bar.current!;
    return () => {
      if (el.contains(document.activeElement)) queueMicrotask(() => document.querySelector<HTMLElement>('.brand')?.focus());
    };
  }, []);

  const commitLabel = () => {
    setEditing(false);
    if (draft.trim() !== session.label) void edit({ label: draft.trim() });
  };

  return (
    <div ref={bar} className={`running-bar${paused ? ' is-paused' : ''}${due ? ' is-due' : ''}`}>
      <div className="running-bar-inner">
        <span className="running-dot" aria-hidden="true" />
        {linked ? (
          <span className="running-label">{name}</span>
        ) : editing ? (
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
              setDraft(session.label);
              setReturnFocus(false);
              setEditing(true);
            }}
            title="Edit label"
          >
            <SessionLabel label={name} />
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
