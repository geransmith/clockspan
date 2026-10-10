import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useBreak } from '../hooks/useBreak';
import { useDayStore } from '../hooks/useDay';
import { useSettings } from '../hooks/useSettings';
import { useShortcut } from '../hooks/useShortcuts';
import { useTimeFormat } from '../hooks/useTimeFormat';
import { useSubmit } from '../hooks/useSubmit';
import { useTimer } from '../hooks/useTimer';
import type { CategoryPick } from '../lib/board';
import { BREAK, TIMER_DUE } from '../lib/copy';
import { formatCountdown, formatDuration } from '../lib/format';
import { hasRoom, isTaskRow } from '../lib/priorities';
import { LIMITS } from '../../../shared/api.js';
import { sameText } from '../../../shared/text.js';
import type { Priority, Session } from '../types';
import { CategoryChip } from './CategoryChip';
import { SessionLabel } from './SessionLabel';
import { TimerControls } from './TimerControls';
import { TimerLengths } from './TimerLengths';
import { ErrorLine } from './ErrorLine';

interface Props {
  date: string;
  isToday: boolean;
  priorities: Priority[];
  /** The category chip's data: "Also add to today's priorities" offers a category for the row. Null (the board off) shows none. */
  pick: CategoryPick | null;
}

export function FocusTimer({ date, isToday, priorities, pick }: Props) {
  const timer = useTimer();
  const breakTimer = useBreak();
  const { addPriority } = useDayStore();
  const { settings } = useSettings();
  const { formatTime } = useTimeFormat();
  const [label, setLabel] = useState('');
  const [linked, setLinked] = useState<string | null>(null);
  const [addAsPriority, setAddAsPriority] = useState(false);
  // The new row's category, offered beside "Also add to today's priorities" while it is ticked.
  const [category, setCategory] = useState<string | null>(null);
  // A start (of a timer or a break) is out, here or on the board (`timer.starting`): the start
  // and break buttons are disabled until it answers. A second start would add the priority twice
  // and meet the first timer as a 409, which reads as one started on another device. A break goes
  // out on the day store's queue, not the timer's, so the two could reach the server in either
  // order: a new break would meet the running timer (409, "Change not saved"), a timer started
  // behind a break start could land first, and an end would find the break the start already
  // ended. The break banners, whose Start break the disabled buttons don't reach, go in the
  // timer start's tap (`TimerLengths`).
  const { busy, error, run } = useSubmit();
  const held = busy || timer.starting;
  // R is the Break button, so a break it starts holds the start buttons as a tap does.
  const startBreak = () => run(() => breakTimer.start(breakTimer.next.minutes));
  const breakKey = useShortcut('rest', !timer.running && isToday && breakTimer.endsAt == null && !held ? startBreak : null);
  // A press whose control the answer takes away (a start, Break, End break, the running card's
  // end) hands the focus to the control that mounts in its place: a stable ref callback runs only
  // on mount, where an inline one would run on every render and take the focus back. It acts only
  // while the focus is on the page's body, so a focus moved meanwhile stays put, and a hand-off
  // nothing took (a start that failed) is dropped once nothing is out.
  const handOff = useRef(false);
  const passFocus = useCallback(() => {
    handOff.current = true;
  }, []);
  const takeFocus = useCallback((el: HTMLElement | null) => {
    if (!el || !handOff.current || document.activeElement !== document.body) return;
    el.focus();
    if (document.activeElement === el) handOff.current = false;
  }, []);
  useEffect(() => {
    if (!held) handOff.current = false;
  });

  if (timer.running) return <Running session={timer.running} takeFocus={takeFocus} onLeave={passFocus} />;

  // Open rows only: a done priority isn't something to start a session for.
  const open = priorities.filter((p) => isTaskRow(p) && !p.done);
  const linkedStillOpen = linked != null && open.some((p) => p.uid === linked);
  const trimmed = label.trim();
  // An open row whose text was typed (a chip unlinked, its row's name typed) is on the plan
  // already, as Plan tomorrow judges it (`sameItem`): the session starts on it, as its chip would.
  const named = open.find((p) => sameText(p.text) === sameText(trimmed));
  // New work typed in, not tied to a row: offer to put it on the plan as well, while the plan
  // has a row for it. On a full list the tick would only earn an error at Start.
  const offerAdd = isToday && trimmed !== '' && !linkedStillOpen && !named && hasRoom(priorities, settings.priorityCount);

  const toggleLink = (p: Priority) => {
    if (linked === p.uid) {
      setLinked(null);
      return;
    }
    setLinked(p.uid);
    setLabel(p.text);
    setAddAsPriority(false);
  };

  const start = (minutes: number) => {
    // Set before the send: the running card can mount before this continues.
    passFocus();
    run(async () => {
      // The new row's save goes in as the start's uid, so the timer counts the start as out from the tap.
      const uid =
        offerAdd && addAsPriority
          ? // With the board off there is no chip, and a category picked before it went off isn't shown.
            addPriority(date, trimmed, pick ? category : null).then((added) => {
              // Linked from here on, so a retry after a failed start uses this row instead of adding another.
              setLinked(added);
              setAddAsPriority(false);
              setCategory(null);
              return added;
            })
          : linkedStillOpen
            ? linked
            : (named?.uid ?? null);
      // Back to work: the server ends a running break as the session starts, so nothing to send here.
      await timer.start(date, minutes * 60, trimmed, uid);
      setLabel('');
      setLinked(null);
      setAddAsPriority(false);
      setCategory(null);
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
        ref={takeFocus}
      />
      {isToday && open.length > 0 && (
        <div className="timer-priorities">
          <span className="muted small">Working on</span>
          <span className="chips">
            {open.map((p) => (
              <button
                key={p.uid}
                className="chip"
                onClick={() => toggleLink(p)}
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
        <div className="timer-add">
          <label className="inline-check timer-add-priority">
            <input type="checkbox" className="checkbox" checked={addAsPriority} onChange={(e) => setAddAsPriority(e.target.checked)} />
            <span>Also add to today's priorities</span>
          </label>
          {pick && addAsPriority && <CategoryChip value={category} onChange={setCategory} pick={pick} label="Category for the new priority" />}
        </div>
      )}
      {breakTimer.endsAt != null && (
        <div className="timer-break">
          <span className="timer-break-text">
            <span>{BREAK.running(formatTime(breakTimer.endsAt))}</span>
            {/* A timer, like the focus ring's: a live region would read it out every second. */}
            <strong role="timer">{formatCountdown(breakTimer.remainingSeconds)}</strong>
          </span>
          <button
            className="btn btn-ghost"
            onClick={() => {
              passFocus();
              breakTimer.end();
            }}
            disabled={held}
            ref={takeFocus}
          >
            {BREAK.end}
          </button>
        </div>
      )}
      <TimerLengths onStart={start} disabled={!isToday || held} />
      {isToday && breakTimer.endsAt == null && (
        <button
          className="btn btn-ghost timer-break-start"
          onClick={() => {
            passFocus();
            startBreak();
          }}
          disabled={held}
          aria-keyshortcuts={breakKey}
          ref={takeFocus}
        >
          {BREAK.start(breakTimer.next.minutes, breakTimer.next.long)}
        </button>
      )}
      {!isToday && <p className="muted center">Timers can only be started on today's sheet.</p>}
      <ErrorLine error={error} />
    </div>
  );
}

function Running({
  session,
  takeFocus,
  onLeave,
}: {
  session: Session;
  takeFocus: (el: HTMLElement | null) => void;
  /** The card is leaving with the focus in it (Finish, Cancel, an end elsewhere): the label box takes it. */
  onLeave: () => void;
}) {
  const { name, countdownSeconds, progress, paused, due } = useTimer();
  const root = useRef<HTMLDivElement>(null);
  // A layout cleanup runs while the card is still in the page, so it can tell where the focus was.
  useLayoutEffect(() => {
    const el = root.current!;
    return () => {
      if (el.contains(document.activeElement)) onLeave();
    };
  }, [onLeave]);
  const r = 54;
  const circ = 2 * Math.PI * r;
  // Past the end the countdown goes negative; the sub-line says why.
  const subline = due ? TIMER_DUE.title : paused ? 'Paused' : `of ${formatDuration(session.plannedSeconds)}`;

  return (
    <div ref={root} className={`timer--running${paused ? ' is-paused' : ''}${due ? ' is-due' : ''}`}>
      <div className="ring-wrap">
        <svg className="ring" viewBox="0 0 120 120" aria-hidden="true">
          <circle className="ring-track" cx="60" cy="60" r={r} />
          <circle className="ring-fill" cx="60" cy="60" r={r} strokeDasharray={circ} strokeDashoffset={circ * (1 - progress)} />
        </svg>
        <div className="ring-center">
          <div className="countdown" role="timer" aria-label={due ? 'Time over' : 'Time remaining'}>
            {formatCountdown(countdownSeconds)}
          </div>
          <div className="muted small">{subline}</div>
        </div>
      </div>
      <div className="timer-running-label">
        <SessionLabel label={name} />
      </div>
      <TimerControls takeFocus={takeFocus} />
    </div>
  );
}
