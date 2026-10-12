import { useId, useRef, useState, type ReactNode } from 'react';
import { LIMITS } from '../../../shared/api.js';
import { isoWeekday, MINUTE_MS } from '../../../shared/dates.js';
import { WEEKLY_MEETINGS_MAX } from '../../../shared/settings.js';
import { meetingTitle } from '../../../shared/text.js';
import { useFollowedDraft } from '../hooks/useFollowedDraft';
import { useSettings } from '../hooks/useSettings';
import { useTimeFormat } from '../hooks/useTimeFormat';
import { warnSaveFailed } from '../lib/alerts';
import { CONFIRM, MEETING_ENDS_FIRST, WEEKLY_MEETINGS_FULL } from '../lib/copy';
import { changeWeekly, currentPart, dayMeetings, minuteOfDay, occurrence, renameWeekly, stopWeekly, type MeetingRow } from '../lib/meetings';
import { newUid } from '../lib/priorities';
import { repeatDays } from '../lib/recurring';
import type { Day, Meeting, WeeklyMeeting } from '../types';
import { ErrorLine } from './ErrorLine';
import { Plus, X } from './Icons';
import { RepeatDays } from './RepeatDays';
import { TimeField } from './TimeField';

/** What a new meeting runs to when only its start is typed: the length most calls are booked for. */
const DEFAULT_MINUTES = 30;
const DAY_MINUTES = 24 * 60;

interface Props {
  date: string;
  today: string;
  meetings: Day['meetings'];
  /** One meeting on the day by its uid, or null to take a weekly one off the day. */
  onSet: (uid: string, meeting: Meeting | null) => void;
  /** Clears the day's own entry for a meeting: a one-off leaves the day, a weekly one follows its usual times. */
  onClear: (uid: string) => void;
}

/**
 * The day's meetings: one-offs, and the weekly meetings on that date (`Settings.meetings`). A row's
 * times edit the meeting on this day only, as a punch saves, the moment they are complete; its title
 * is a one-off's own, or a weekly meeting's on every day. × takes a one-off off the day and skips a
 * weekly one there, which stays listed with Put Back. A weekly row's days button opens its days,
 * usual time and Stop Repeating, which change it from today on (`changeWeekly`).
 */
export function Meetings({ date, today, meetings, onSet, onClear }: Props) {
  const { settings, update } = useSettings();
  const weekly = settings.meetings;
  const { hour12, formatTime } = useTimeFormat();
  const sorted = dayMeetings(date, meetings, weekly);
  // While the focus is in the card the rows keep their places: a time saves on each key, and a row
  // moved in the page under the focus would lose it. They sort again once the focus leaves.
  const [held, setHeld] = useState<string[] | null>(null);
  const place = (uid: string) => (held!.includes(uid) ? held!.indexOf(uid) : held!.length);
  const rows = held ? [...sorted].sort((a, b) => place(a.uid) - place(b.uid)) : sorted;
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  // Add Meeting comes back in the form's place: it takes the focus as it mounts.
  const focusAdd = useRef(false);
  const panelId = useId();
  const saveWeekly = (next: WeeklyMeeting[]) => void update({ meetings: next }).catch(warnSaveFailed);
  const closeForm = () => {
    focusAdd.current = true;
    setAdding(false);
  };
  // A press that takes its row away hands the focus to the next row's ×, else the one before, else
  // Add Meeting, or the new meeting's title while its row is open.
  const handOn = (from: HTMLElement) => {
    const card = from.closest('.meetings')!;
    const row = from.closest('.meeting-row')!;
    const others = [...card.querySelectorAll<HTMLElement>('.meeting-remove')].filter((b) => !row.contains(b));
    const next = others.find((b) => row.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ?? others.at(-1);
    (next ?? card.querySelector<HTMLElement>('.meeting-add, .meeting-new .meeting-title'))?.focus();
  };
  const running = weekly.filter((w) => w.until == null).length;

  return (
    <div
      className="meetings"
      onFocus={() => setHeld((order) => order ?? sorted.map((r) => r.uid))}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setHeld(null);
      }}
    >
      {rows.length === 0 && !adding && <p className="muted">No meetings on this day.</p>}
      {rows.map((row) => {
        const name = row.meeting.title || `Meeting at ${formatTime(row.meeting.startsAt)}`;
        const part = currentPart(weekly, row.uid);
        return (
          <MeetingLine
            key={row.uid}
            row={row}
            name={name}
            date={date}
            hour12={hour12}
            onTimes={(startsAt, endsAt) => onSet(row.uid, { title: row.weekly ? null : row.meeting.title, startsAt, endsAt })}
            onTitle={(title) => (row.weekly ? saveWeekly(renameWeekly(weekly, row.uid, title)) : onSet(row.uid, { ...row.meeting, title }))}
            onRemove={(button) => {
              if (row.weekly) onSet(row.uid, null);
              else {
                handOn(button);
                onClear(row.uid);
              }
            }}
            onPutBack={() => onClear(row.uid)}
            days={
              part && {
                label: repeatDays(part.weekdays),
                open: open === row.uid,
                panelId: `${panelId}-${row.uid}`,
                onToggle: () => setOpen(open === row.uid ? null : row.uid),
              }
            }
          >
            {part && open === row.uid && (
              <WeeklyPanel
                id={`${panelId}-${row.uid}`}
                part={part}
                name={name}
                date={date}
                hour12={hour12}
                onChange={(patch, pressed) => {
                  // A day turned off that this sheet's date falls on takes the row away from today on.
                  if (pressed && date >= today && patch.weekdays && !patch.weekdays.includes(isoWeekday(date))) handOn(pressed);
                  saveWeekly(changeWeekly(weekly, row.uid, patch, today));
                }}
                onStop={(pressed) => {
                  if (!window.confirm(CONFIRM.stopMeeting(name))) return;
                  if (date >= today) handOn(pressed);
                  setOpen(null);
                  saveWeekly(stopWeekly(weekly, row.uid, today));
                }}
              />
            )}
          </MeetingLine>
        );
      })}
      {adding ? (
        <NewMeeting
          date={date}
          hour12={hour12}
          full={running >= WEEKLY_MEETINGS_MAX}
          onAdd={(m, days) => {
            if (days.length === 0) onSet(newUid(), m);
            else {
              const part = {
                uid: newUid(),
                title: m.title,
                weekdays: days,
                start: minuteOfDay(m.startsAt),
                end: minuteOfDay(m.endsAt),
                since: date,
                until: null,
              };
              saveWeekly([...weekly, part]);
            }
            closeForm();
          }}
          onCancel={closeForm}
        />
      ) : (
        <button
          ref={(el) => {
            addButton.current = el;
            if (el && focusAdd.current) {
              focusAdd.current = false;
              el.focus();
            }
          }}
          className="btn btn-ghost meeting-add"
          onClick={() => setAdding(true)}
        >
          <Plus />
          Add Meeting
        </button>
      )}
    </div>
  );
}

function MeetingLine({
  row,
  name,
  date,
  hour12,
  onTimes,
  onTitle,
  onRemove,
  onPutBack,
  days,
  children,
}: {
  row: MeetingRow;
  /** How the row's controls are named: its title, else its start. */
  name: string;
  date: string;
  hour12: boolean;
  onTimes: (startsAt: number, endsAt: number) => void;
  onTitle: (title: string) => void;
  onRemove: (button: HTMLButtonElement) => void;
  onPutBack: () => void;
  /** A weekly meeting still repeating: its days button, which opens the panel (`children`). */
  days: { label: string; open: boolean; panelId: string; onToggle: () => void } | undefined;
  children: ReactNode;
}) {
  const { meeting } = row;
  const [title, setTitle] = useFollowedDraft(meeting.title);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  // × and Put Back stand in for each other in the row: the one that shows takes the focus.
  const handBack = useRef(false);
  const takeFocus = (el: HTMLButtonElement | null) => {
    if (el && handBack.current) {
      handBack.current = false;
      el.focus();
    }
  };
  const saveTitle = () => {
    const next = meetingTitle(title);
    if (next === meeting.title) setTitle(meeting.title);
    else onTitle(next);
  };

  if (row.skipped)
    return (
      <div className="meeting-row meeting-skipped">
        <span className="meeting-skipped-name">{name}</span>
        <span className="pill">skipped</span>
        <button
          ref={takeFocus}
          className="btn btn-ghost"
          onClick={() => {
            handBack.current = true;
            onPutBack();
          }}
          aria-label={`Put back ${name}`}
        >
          Put Back
        </button>
      </div>
    );

  return (
    <div className={`meeting-row${row.weekly ? ' is-weekly' : ''}`}>
      <div className="meeting-times">
        <TimeField
          value={meeting.startsAt}
          date={date}
          hour12={hour12}
          anchorAt={null}
          label={`${name} start`}
          // A new start moves the meeting and keeps its length.
          onCommit={(ms) => {
            setError(null);
            onTimes(ms, ms + meeting.endsAt - meeting.startsAt);
          }}
        />
        <span aria-hidden="true">–</span>
        <TimeField
          value={meeting.endsAt}
          date={date}
          hour12={hour12}
          anchorAt={meeting.startsAt}
          label={`${name} end`}
          errorId={error ? errorId : undefined}
          onCommit={(ms) => {
            setError(ms > meeting.startsAt ? null : MEETING_ENDS_FIRST);
            if (ms > meeting.startsAt) onTimes(meeting.startsAt, ms);
          }}
        />
      </div>
      <input
        className="input meeting-title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={saveTitle}
        onKeyDown={(e) => {
          if (e.key === 'Enter') saveTitle();
        }}
        placeholder="Title (optional)"
        aria-label={`Title of ${name}`}
        maxLength={LIMITS.meetingTitle}
      />
      {days && (
        <button
          className="btn btn-ghost meeting-days"
          onClick={days.onToggle}
          aria-expanded={days.open}
          aria-controls={days.panelId}
          aria-label={`${name} repeats ${days.label}`}
          title="Days and usual time"
        >
          {days.label}
        </button>
      )}
      <button
        ref={takeFocus}
        className="btn btn-icon meeting-remove"
        onClick={(e) => {
          if (row.weekly) handBack.current = true;
          onRemove(e.currentTarget);
        }}
        aria-label={row.weekly ? `Skip ${name} on this day` : `Remove ${name}`}
        title={row.weekly ? 'Skip on this day' : 'Remove'}
      >
        <X />
      </button>
      <ErrorLine error={error} id={errorId} />
      {children}
    </div>
  );
}

/** A weekly meeting's days, usual time and Stop Repeating, under its row; each change holds from today on. */
function WeeklyPanel({
  id,
  part,
  name,
  date,
  hour12,
  onChange,
  onStop,
}: {
  id: string;
  part: WeeklyMeeting;
  name: string;
  date: string;
  hour12: boolean;
  /** A change from today on; `pressed`, a day button, is the control the change may take away. */
  onChange: (patch: Partial<Pick<WeeklyMeeting, 'weekdays' | 'start' | 'end'>>, pressed?: HTMLElement) => void;
  onStop: (pressed: HTMLElement) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const usual = occurrence(part, date);
  return (
    <div id={id} className="meeting-weekly">
      <RepeatDays
        id={`${id}-repeat`}
        days={part.weekdays}
        onDay={(day, on, pressed) =>
          onChange({ weekdays: on ? [...part.weekdays, day].sort((a, b) => a - b) : part.weekdays.filter((d) => d !== day) }, pressed)
        }
        onStop={onStop}
      />
      <div className="meeting-usual">
        <span className="muted small">Usual time</span>
        <div className="meeting-times">
          <TimeField
            value={usual.startsAt}
            date={date}
            hour12={hour12}
            anchorAt={null}
            label={`${name} usual start`}
            onCommit={(ms) => {
              setError(null);
              const start = minuteOfDay(ms);
              onChange({ start, end: Math.min(DAY_MINUTES, start + part.end - part.start) });
            }}
          />
          <span aria-hidden="true">–</span>
          <TimeField
            value={usual.endsAt}
            date={date}
            hour12={hour12}
            anchorAt={usual.startsAt}
            label={`${name} usual end`}
            errorId={error ? errorId : undefined}
            onCommit={(ms) => {
              const end = minuteOfDay(ms);
              setError(end > part.start ? null : MEETING_ENDS_FIRST);
              if (end > part.start) onChange({ end });
            }}
          />
        </div>
      </div>
      <ErrorLine error={error} id={errorId} />
    </div>
  );
}

function NewMeeting({
  date,
  hour12,
  full,
  onAdd,
  onCancel,
}: {
  date: string;
  hour12: boolean;
  /** The settings hold no more weekly meetings. */
  full: boolean;
  /** The meeting, and its weekdays: none for a one-off on this day. */
  onAdd: (m: Meeting & { title: string }, days: number[]) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [startsAt, setStartsAt] = useState<number | null>(null);
  const [endsAt, setEndsAt] = useState<number | null>(null);
  const [days, setDays] = useState<number[]>([]);
  // Until End is typed it follows Start, which saves on each key: "930" is 9:03 before 9:30.
  const [endTyped, setEndTyped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const repeatId = useId();
  const add = () => {
    if (startsAt == null || endsAt == null) return;
    // A weekly meeting keeps minutes of the day, so it can't run past midnight.
    if (endsAt <= startsAt || (days.length > 0 && minuteOfDay(endsAt) <= minuteOfDay(startsAt))) setError(MEETING_ENDS_FIRST);
    else if (days.length > 0 && full) setError(WEEKLY_MEETINGS_FULL);
    else onAdd({ title: meetingTitle(title), startsAt, endsAt }, days);
  };
  return (
    <div className="meeting-row meeting-new" role="group" aria-label="New meeting">
      <input
        className="input meeting-title"
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') add();
          else if (e.key === 'Escape') onCancel();
        }}
        placeholder="Title (optional)"
        aria-label="Title"
        maxLength={LIMITS.meetingTitle}
      />
      <div className="meeting-times">
        <TimeField
          value={startsAt}
          date={date}
          hour12={hour12}
          anchorAt={null}
          label="Start"
          onCommit={(ms) => {
            setError(null);
            setStartsAt(ms);
            if (!endTyped) setEndsAt(ms + DEFAULT_MINUTES * MINUTE_MS);
          }}
        />
        <span aria-hidden="true">–</span>
        <TimeField
          value={endsAt}
          date={date}
          hour12={hour12}
          anchorAt={startsAt}
          label="End"
          errorId={error ? errorId : undefined}
          onCommit={(ms) => {
            setError(null);
            setEndTyped(true);
            setEndsAt(ms);
          }}
        />
      </div>
      <RepeatDays
        id={repeatId}
        days={days}
        optional
        onDay={(day, on) => {
          setError(null);
          setDays((now) => (on ? [...now, day].sort((a, b) => a - b) : now.filter((d) => d !== day)));
        }}
      />
      <div className="meeting-new-actions">
        <button className="btn btn-primary" onClick={add} disabled={startsAt == null || endsAt == null}>
          Add
        </button>
        <button className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <ErrorLine error={error} id={errorId} />
    </div>
  );
}
