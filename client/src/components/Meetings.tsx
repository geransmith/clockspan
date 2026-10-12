import { useId, useRef, useState } from 'react';
import { LIMITS } from '../../../shared/api.js';
import { MINUTE_MS } from '../../../shared/dates.js';
import { meetingTitle } from '../../../shared/text.js';
import { useFollowedDraft } from '../hooks/useFollowedDraft';
import { useTimeFormat } from '../hooks/useTimeFormat';
import { MEETING_ENDS_FIRST } from '../lib/copy';
import { focusNeighbour } from '../lib/focus';
import { dayMeetings } from '../lib/meetings';
import { newUid } from '../lib/priorities';
import type { Day, Meeting } from '../types';
import { ErrorLine } from './ErrorLine';
import { Plus, X } from './Icons';
import { TimeField } from './TimeField';

/** What a new meeting runs to when only its start is typed: the length most calls are booked for. */
const DEFAULT_MINUTES = 30;

interface Props {
  date: string;
  meetings: Day['meetings'];
  /** One meeting by its uid, or null to take it off the day. */
  onSet: (uid: string, meeting: Meeting | null) => void;
}

/**
 * The day's meetings: each row's times and title edit that meeting on this day, and × takes it off.
 * A row saves the moment a time is complete, as a punch does, and its title on blur or Enter.
 */
export function Meetings({ date, meetings, onSet }: Props) {
  const { hour12, formatTime } = useTimeFormat();
  const rows = dayMeetings(meetings);
  const [adding, setAdding] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  // Add Meeting comes back in the form's place: it takes the focus as it mounts.
  const focusAdd = useRef(false);
  const closeForm = () => {
    focusAdd.current = true;
    setAdding(false);
  };

  return (
    <div className="meetings">
      {rows.length === 0 && !adding && <p className="muted">No meetings on this day.</p>}
      {rows.map(([uid, m]) => (
        <MeetingRow
          key={uid}
          meeting={m}
          name={m.title || `Meeting at ${formatTime(m.startsAt)}`}
          date={date}
          hour12={hour12}
          onChange={(next) => onSet(uid, next)}
          onRemove={(button) => {
            if (rows.length > 1) focusNeighbour(button, '.meetings', '.meeting-remove');
            else addButton.current?.focus();
            onSet(uid, null);
          }}
        />
      ))}
      {adding ? (
        <NewMeeting
          date={date}
          hour12={hour12}
          onAdd={(m) => {
            onSet(newUid(), m);
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

function MeetingRow({
  meeting,
  name,
  date,
  hour12,
  onChange,
  onRemove,
}: {
  meeting: Meeting;
  /** How the row's controls are named: its title, else its start. */
  name: string;
  date: string;
  hour12: boolean;
  onChange: (meeting: Meeting) => void;
  onRemove: (button: HTMLButtonElement) => void;
}) {
  const [title, setTitle] = useFollowedDraft(meeting.title);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const saveTitle = () => {
    const next = meetingTitle(title);
    if (next === meeting.title) setTitle(meeting.title);
    else onChange({ ...meeting, title: next });
  };
  return (
    <div className="meeting-row">
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
            onChange({ ...meeting, startsAt: ms, endsAt: ms + meeting.endsAt - meeting.startsAt });
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
            if (ms > meeting.startsAt) onChange({ ...meeting, endsAt: ms });
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
      <button className="btn btn-icon meeting-remove" onClick={(e) => onRemove(e.currentTarget)} aria-label={`Remove ${name}`} title="Remove">
        <X />
      </button>
      <ErrorLine error={error} id={errorId} />
    </div>
  );
}

function NewMeeting({ date, hour12, onAdd, onCancel }: { date: string; hour12: boolean; onAdd: (m: Meeting) => void; onCancel: () => void }) {
  const [title, setTitle] = useState('');
  const [startsAt, setStartsAt] = useState<number | null>(null);
  const [endsAt, setEndsAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const add = () => {
    if (startsAt == null || endsAt == null) return;
    if (endsAt <= startsAt) setError(MEETING_ENDS_FIRST);
    else onAdd({ title: meetingTitle(title), startsAt, endsAt });
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
            setEndsAt((end) => end ?? ms + DEFAULT_MINUTES * MINUTE_MS);
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
            setEndsAt(ms);
          }}
        />
      </div>
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
