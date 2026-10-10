import { type KeyboardEvent, type ReactNode, type Ref, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useBreak } from '../hooks/useBreak';
import { useDayStore } from '../hooks/useDay';
import { useSettings } from '../hooks/useSettings';
import { useShortcut } from '../hooks/useShortcuts';
import { useTimeFormat } from '../hooks/useTimeFormat';
import { useSubmit } from '../hooks/useSubmit';
import { useTimer } from '../hooks/useTimer';
import type { CategoryPick } from '../lib/board';
import { BREAK, SAVE_FAILED, TIMER_DUE } from '../lib/copy';
import { formatCountdown, formatDuration } from '../lib/format';
import { hasRoom, isTaskRow } from '../lib/priorities';
import { LIMITS } from '../../../shared/api.js';
import { sameText } from '../../../shared/text.js';
import type { Priority, Session } from '../types';
import { CategoryChip, placeList } from './CategoryChip';
import { SessionLabel } from './SessionLabel';
import { TimerControls } from './TimerControls';
import { TimerLengths } from './TimerLengths';
import { ErrorLine } from './ErrorLine';

interface Props {
  date: string;
  isToday: boolean;
  priorities: Priority[];
  /** The category chip's data: a new name typed in the label box offers a category for its row. Null (before the board's first read) shows none. */
  pick: CategoryPick | null;
}

export function FocusTimer({ date, isToday, priorities, pick }: Props) {
  const timer = useTimer();
  const breakTimer = useBreak();
  const { addPriority } = useDayStore();
  const { settings } = useSettings();
  const { formatTime } = useTimeFormat();
  const [label, setLabel] = useState('');
  // The row picked from the label box's list, so a pick between two rows of one name starts on the one picked.
  const [linked, setLinked] = useState<string | null>(null);
  // The new row's category, offered beside the label box while the name typed matches no open row.
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
  // A control the answer takes away hands the focus to the control that mounts in its place: a
  // start or Break sets the flag in its tap, and the running card and the break's row as they
  // leave with the focus inside (`PassFocusOnLeave`), since an End break's row goes only once the
  // one-second clock reaches the end it stamped. A stable ref callback runs only on mount, where
  // an inline one would run on every render and take the focus back. It acts only while the focus
  // is on the page's body, so a focus moved meanwhile stays put, and a hand-off nothing took (a
  // start that failed) is dropped once nothing is out.
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
  // An open row whose text was typed is on the plan already (`sameText`): the session starts on
  // it, as a pick would.
  const named = open.find((p) => sameText(p.text) === sameText(trimmed));
  // New work typed in, not tied to an open row, goes on today's list as the session starts, while
  // the list has a row for it: a timer never refuses to start, so on a full one it runs on no task.
  const offerAdd = isToday && trimmed !== '' && !linkedStillOpen && !named && hasRoom(priorities, settings.priorityCount);

  const start = (minutes: number) => {
    // Set before the send: the running card can mount before this continues.
    passFocus();
    run(async () => {
      // The new row's save goes in as the start's uid, so the timer counts the start as out from the tap.
      const uid = offerAdd
        ? addPriority(date, trimmed, category).then((added) => {
            // Linked from here on, so a retry after a failed start uses this row instead of adding another.
            setLinked(added);
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
      setCategory(null);
    });
  };

  return (
    <div className="stack">
      <div className="timer-label">
        <LabelBox
          value={label}
          rows={open}
          disabled={!isToday}
          inputRef={takeFocus}
          onType={(text) => {
            setLabel(text);
            setLinked(null);
          }}
          onPick={(p) => {
            setLabel(p.text);
            setLinked(p.uid);
          }}
        />
        {pick && offerAdd && <CategoryChip value={category} onChange={setCategory} pick={pick} label="Category for the new priority" />}
      </div>
      {breakTimer.endsAt != null && (
        <PassFocusOnLeave className="timer-break" onLeave={passFocus}>
          <span className="timer-break-text">
            <span>{BREAK.running(formatTime(breakTimer.endsAt))}</span>
            {/* A timer, like the focus ring's: a live region would read it out every second. */}
            <strong role="timer">{formatCountdown(breakTimer.remainingSeconds)}</strong>
          </span>
          <button className="btn btn-ghost" onClick={breakTimer.end} disabled={held} ref={takeFocus}>
            {BREAK.end}
          </button>
        </PassFocusOnLeave>
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
      {/* A new row's failed save is the "Change not saved" banner's to say; the list full or not loaded, and the start's own errors, show here. */}
      <ErrorLine error={error === SAVE_FAILED.title ? null : error} />
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
  const r = 54;
  const circ = 2 * Math.PI * r;
  // Past the end the countdown goes negative; the sub-line says why.
  const subline = due ? TIMER_DUE.title : paused ? 'Paused' : `of ${formatDuration(session.plannedSeconds)}`;

  return (
    <PassFocusOnLeave className={`timer--running${paused ? ' is-paused' : ''}${due ? ' is-due' : ''}`} onLeave={onLeave}>
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
    </PassFocusOnLeave>
  );
}

/** The list at the box's width, under the box or above it, as the category chip's list is placed. */
function placeUnder(box: HTMLElement | null, list: HTMLElement | null): void {
  if (!box || !list) return;
  list.style.width = `${box.offsetWidth}px`;
  placeList(box, list);
}

/**
 * The session label box: an ARIA 1.2 combobox listing today's open rows, numbered, narrowed to the
 * rows whose text holds what is typed. It opens as the box takes the focus from another control
 * (Tab), on a press, on typing and on ↓ or ↑, but not for a focus that comes from nowhere: the one
 * handed to it as the running card leaves, which would cover the card after every session, or the
 * one the window gives back as it returns. The focus stays in the box: ↓ and ↑ move the active
 * option without wrapping, Enter picks it and Escape closes the list. The list is
 * `position: fixed`, so the card's height never changes and its overflow can't clip it.
 */
function LabelBox({
  value,
  rows,
  disabled,
  inputRef,
  onType,
  onPick,
}: {
  value: string;
  rows: Priority[];
  disabled: boolean;
  inputRef: Ref<HTMLInputElement>;
  onType: (text: string) => void;
  onPick: (row: Priority) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const wrap = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const id = useId();
  const matches = rows.filter((p) => sameText(p.text).includes(sameText(value)));
  const shown = open ? matches : [];
  // None at -1, or once the rows shrink under the index (another device ticks one).
  const current = shown[active];

  // After every render while it shows, since the rows can change under it, and on any scroll or
  // resize.
  useLayoutEffect(() => placeUnder(wrap.current, pop.current));
  // Into the list's view as the keys move it, as the focus would scroll it; never on the card's
  // one-second renders, which would undo a scroll of the list by wheel or touch. In braces: Chrome's
  // scrollIntoView returns a promise, which React would take for the effect's cleanup.
  useLayoutEffect(() => {
    document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [id, active]);
  const showing = shown.length > 0;
  useEffect(() => {
    if (!showing) return;
    const follow = () => placeUnder(wrap.current, pop.current);
    window.addEventListener('scroll', follow, true);
    window.addEventListener('resize', follow);
    return () => {
      window.removeEventListener('scroll', follow, true);
      window.removeEventListener('resize', follow);
    };
  }, [showing]);

  const close = () => {
    setOpen(false);
    setActive(-1);
  };
  const pick = (p: Priority) => {
    onPick(p);
    close();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      setActive(e.key === 'ArrowDown' ? Math.min(active + 1, matches.length - 1) : Math.max(active - 1, 0));
    } else if (e.key === 'Enter' && current) {
      e.preventDefault();
      pick(current);
    } else if (e.key === 'Escape' && showing) {
      e.preventDefault();
      close();
    }
  };

  return (
    <div ref={wrap} className="timer-label-box">
      <input
        ref={inputRef}
        className="input"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showing}
        aria-controls={showing ? id : undefined}
        aria-activedescendant={current ? `${id}-${active}` : undefined}
        aria-label="Session label"
        value={value}
        placeholder="What are you working on?"
        maxLength={LIMITS.sessionLabel}
        disabled={disabled}
        onChange={(e) => {
          onType(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={(e) => {
          if (e.relatedTarget) setOpen(true);
        }}
        onClick={() => setOpen(true)}
        onBlur={close}
        onKeyDown={onKeyDown}
      />
      {showing && (
        <div
          ref={pop}
          className="category-pop timer-suggest"
          // A press on the list leaves the focus in the box, so its blur doesn't close the list
          // before the click picks the option pressed. The options are picked from the box with
          // the keys, so these handlers only serve the mouse and touch, and the wrapper is
          // presentation to a screen reader.
          role="presentation"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            const option = (e.target as Element).closest<HTMLElement>('[role="option"]');
            const p = option && shown[Number(option.dataset.index)];
            if (p) pick(p);
          }}
        >
          <div id={id} className="category-options" role="listbox" aria-label="Today's open priorities">
            {shown.map((p, i) => (
              <div key={p.uid} id={`${id}-${i}`} data-index={i} role="option" aria-selected={i === active} className="category-option">
                <span className="chip-num">{p.position}</span>
                <span className="category-option-name">{p.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** A block that calls `onLeave` as it leaves the page with the focus inside it. */
export function PassFocusOnLeave({ className, onLeave, children }: { className: string; onLeave: () => void; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  // A layout cleanup runs while the block is still in the page, so it can tell where the focus was.
  useLayoutEffect(() => {
    const el = root.current!;
    return () => {
      if (el.contains(document.activeElement)) onLeave();
    };
  }, [onLeave]);
  return (
    <div ref={root} className={className}>
      {children}
    </div>
  );
}
