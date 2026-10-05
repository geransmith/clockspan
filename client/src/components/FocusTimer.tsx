import { useState } from 'react';
import { useBreak } from '../hooks/useBreak';
import { useSettings } from '../hooks/useSettings';
import { useTimeFormat } from '../hooks/useTimeFormat';
import { useSubmit } from '../hooks/useSubmit';
import { useTimer } from '../hooks/useTimer';
import { dismissByTag, unlockAudio } from '../lib/alerts';
import { BREAK, TIMER_DUE } from '../lib/copy';
import { formatCountdown, formatDuration } from '../lib/format';
import { hasRoom, hasText } from '../lib/priorities';
import { LIMITS } from '../../../shared/api.js';
import type { Priority, Session } from '../types';
import { SessionLabel } from './SessionLabel';
import { TimerControls } from './TimerControls';
import { ErrorLine } from './ErrorLine';

interface Props {
  date: string;
  isToday: boolean;
  priorities: Priority[];
  /** Adds a row to today's priorities and resolves to its uid. */
  onAddPriority: (text: string) => Promise<string>;
}

export function FocusTimer({ date, isToday, priorities, onAddPriority }: Props) {
  const timer = useTimer();
  const breakTimer = useBreak();
  const { settings } = useSettings();
  const { formatTime } = useTimeFormat();
  const [label, setLabel] = useState('');
  const [linked, setLinked] = useState<string | null>(null);
  const [addAsPriority, setAddAsPriority] = useState(false);
  // A start is out: the start and break buttons are disabled until it answers. A second start
  // would add the priority twice and meet the first timer as a 409, which reads as one started
  // on another device. A break tap goes out on the day store's queue, not the timer's, so it
  // could reach the server after the start: a new break would meet the running timer (409,
  // "Change not saved"), and an end would find the break the start already ended. The break
  // banners, whose Start break the disabled buttons don't reach, go in the start's tap.
  const { busy: starting, error, run } = useSubmit();

  if (timer.running) return <Running session={timer.running} />;

  // Shortest first, and a length set twice is one button.
  const lengths = [...new Set(settings.timerMinutes)].sort((a, b) => a - b);

  // Open rows only: a done priority isn't something to start a session for.
  const open = priorities.filter((p) => p.uid && hasText(p) && !p.done);
  const linkedStillOpen = linked != null && open.some((p) => p.uid === linked);
  const trimmed = label.trim();
  // New work typed in, not tied to a row: offer to put it on the plan as well, while the plan
  // has a row for it. On a full list the tick would only earn an error at Start.
  const offerAdd = isToday && trimmed !== '' && !linkedStillOpen && hasRoom(priorities, settings.priorityCount);

  const pick = (p: Priority) => {
    if (linked === p.uid) {
      setLinked(null);
      return;
    }
    setLinked(p.uid);
    setLabel(p.text);
    setAddAsPriority(false);
  };

  const start = (minutes: number) => {
    // Here, in the tap and before any await: iOS counts only the tap as the gesture, and with
    // "Also add to today's priorities" ticked the new row is saved before the timer starts, so
    // the completion chime would stay silent otherwise.
    unlockAudio();
    dismissByTag('break');
    run(async () => {
      let uid = linkedStillOpen ? linked : null;
      if (offerAdd && addAsPriority) {
        uid = await onAddPriority(trimmed);
        // Linked from here on, so a retry after a failed start uses this row instead of adding another.
        setLinked(uid);
        setAddAsPriority(false);
      }
      // Back to work: the server ends a running break as the session starts, so nothing to send here.
      await timer.start(date, minutes * 60, trimmed, uid);
      setLabel('');
      setLinked(null);
      setAddAsPriority(false);
    });
  };

  return (
    <div className="stack">
      <input
        className="input"
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
                className="chip"
                onClick={() => pick(p)}
                aria-pressed={linked === p.uid}
                title={linked === p.uid ? 'Unlink from this priority' : `Link the next session to priority ${p.position}`}
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
      {breakTimer.endsAt != null && (
        <div className="timer-break">
          <span className="timer-break-text">
            <span>{BREAK.running(formatTime(breakTimer.endsAt))}</span>
            {/* A timer, like the focus ring's: a live region would read it out every second. */}
            <strong role="timer">{formatCountdown(breakTimer.remainingSeconds)}</strong>
          </span>
          <button className="btn btn-ghost" onClick={breakTimer.end} disabled={starting}>
            {BREAK.end}
          </button>
        </div>
      )}
      <div className="timer-quick">
        {lengths.map((m) => (
          <button key={m} className="btn btn-quick" onClick={() => start(m)} disabled={!isToday || starting}>
            <span className="timer-quick-num">{m}</span>
            <span className="timer-quick-unit">min</span>
          </button>
        ))}
      </div>
      {isToday && breakTimer.endsAt == null && (
        <button className="btn btn-ghost timer-break-start" onClick={() => breakTimer.start(breakTimer.next.minutes)} disabled={starting}>
          {BREAK.start(breakTimer.next.minutes, breakTimer.next.long)}
        </button>
      )}
      {!isToday && <p className="muted center">Timers can only be started on today's sheet.</p>}
      <ErrorLine error={error} />
    </div>
  );
}

function Running({ session }: { session: Session }) {
  const { countdownSeconds, progress, paused, due } = useTimer();
  const r = 54;
  const circ = 2 * Math.PI * r;
  // Past the end the countdown goes negative; the sub-line says why.
  const subline = due ? TIMER_DUE.title : paused ? 'Paused' : `of ${formatDuration(session.plannedSeconds)}`;

  return (
    <div className={`timer--running${paused ? ' is-paused' : ''}${due ? ' is-due' : ''}`}>
      <div className="ring-wrap">
        <svg className="ring" viewBox="0 0 120 120" aria-hidden="true">
          <circle className="ring-track" cx="60" cy="60" r={r} />
          <circle className="ring-fill" cx="60" cy="60" r={r} strokeDasharray={circ} strokeDashoffset={circ * (1 - progress)} />
        </svg>
        <div className="ring-center">
          <div className="countdown" role="timer">
            {formatCountdown(countdownSeconds)}
          </div>
          <div className="muted small">{subline}</div>
        </div>
      </div>
      <div className="timer-running-label">
        <SessionLabel label={session.label} />
      </div>
      <TimerControls />
    </div>
  );
}
