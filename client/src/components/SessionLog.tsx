import { useRef, useState } from 'react';
import { useDayStore } from '../hooks/useDay';
import { useTimer } from '../hooks/useTimer';
import { CONFIRM, UNTITLED_SESSION } from '../lib/copy';
import { useTimeFormat } from '../hooks/useTimeFormat';
import { breakSeconds } from '../lib/breaks';
import { formatDuration, plural } from '../lib/format';
import { hasText } from '../lib/priorities';
import { focusOf } from '../lib/retro';
import { timerView } from '../lib/timer';
import { LIMITS, type Break, type Priority, type Session } from '../types';
import { Trash } from './Icons';

interface Props {
  date: string;
  isToday: boolean;
  sessions: Session[];
  breaks: Break[];
  priorities: Priority[];
  now: number;
}

type Entry = { at: number; session: Session } | { at: number; brk: Break };

export function SessionLog({ date, isToday, sessions, breaks, priorities, now }: Props) {
  const store = useDayStore();
  const { running, edit } = useTimer();
  const focus = focusOf(sessions);
  const rested = breaks.reduce((sum, b) => sum + breakSeconds(b, now), 0);
  const planned = priorities.filter((p) => p.uid && hasText(p));
  // The running session's row is the timer's copy, and its edits go through the timer: one queue
  // for the session's writes, and an edit or a pause shows here and in the bar at once.
  const live = (s: Session) => s.status === 'running' && s.id === running?.id;
  const rows = running ? sessions.map((s) => (live(s) ? running : s)) : sessions;
  // One list in the order things happened: breaks sit between the sessions they followed.
  const entries: Entry[] = [...rows.map((s) => ({ at: s.startedAt, session: s })), ...breaks.map((b) => ({ at: b.startedAt, brk: b }))].sort(
    (a, b) => a.at - b.at,
  );

  if (entries.length === 0) {
    return (
      <p className="muted center">
        {isToday ? 'No focus sessions yet. Sessions and breaks from the focus timer show up here.' : 'No focus sessions or breaks on this day.'}
      </p>
    );
  }

  return (
    <div className="log">
      <div className="log-total">
        <span className="muted">Total focused</span>
        <strong>{formatDuration(focus.seconds)}</strong>
        <span className="muted">
          · {focus.count} {plural(focus.count, 'session')}
        </span>
      </div>
      {breaks.length > 0 && (
        <div className="log-total">
          <span className="muted">On breaks</span>
          <strong>{formatDuration(rested)}</strong>
          <span className="muted">
            · {breaks.length} {plural(breaks.length, 'break')}
          </span>
        </div>
      )}
      <ul className="log-list">
        {entries.map((e) =>
          'session' in e ? (
            <Row
              key={`s${e.session.id}`}
              session={e.session}
              now={now}
              planned={planned}
              onEdit={(patch) => void (live(e.session) ? edit(patch) : store.updateSession(date, e.session.id, patch))}
              onDelete={() => void store.removeSession(date, e.session.id)}
            />
          ) : (
            <BreakRow key={`b${e.brk.id}`} brk={e.brk} now={now} onDelete={() => void store.removeBreak(date, e.brk.id)} />
          ),
        )}
      </ul>
    </div>
  );
}

/** A break in the log: when, how long, and a delete. Nothing to edit; it has no label or priority. */
function BreakRow({ brk: b, now, onDelete }: { brk: Break; now: number; onDelete: () => void }) {
  const { formatTime } = useTimeFormat();
  const running = b.endedAt > now;
  return (
    <li className={`log-row log-row--break${running ? ' is-running' : ''}`}>
      <span className="log-time">
        {formatTime(b.startedAt)}
        {!running && <> – {formatTime(b.endedAt)}</>}
      </span>
      <span className="log-label log-label--break">Break</span>
      <span className="log-duration">
        {running && <span className="pill pill--ok">on break</span>} {formatDuration(breakSeconds(b, now))}
      </span>
      <button
        className="btn btn-icon log-delete"
        onClick={() => {
          if (window.confirm(CONFIRM.deleteBreak)) onDelete();
        }}
        aria-label="Delete break"
        title="Delete"
        disabled={running}
      >
        <Trash />
      </button>
    </li>
  );
}

function Row({
  session: s,
  now,
  planned,
  onEdit,
  onDelete,
}: {
  session: Session;
  now: number;
  planned: Priority[];
  onEdit: (patch: { label?: string; priorityUid?: string | null }) => void;
  onDelete: () => void;
}) {
  const { formatTime } = useTimeFormat();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(s.label);
  const editBox = useRef<HTMLSpanElement>(null);
  const running = s.status === 'running';
  const paused = running && s.pausedAt != null;
  // A running row counts its focus so far, which holds still while paused.
  const seconds = running ? timerView(s, now).elapsedSeconds : (s.durationSeconds ?? 0);
  // A link to a row that was since removed reads as unplanned.
  const linked = s.priorityUid ? planned.find((p) => p.uid === s.priorityUid) : undefined;
  // One PATCH per edit: label and link together, so two responses can't land out of order.
  const commit = (extra: { priorityUid?: string | null } = {}) => {
    setEditing(false);
    const patch = { ...extra, ...(draft.trim() !== s.label ? { label: draft.trim() } : {}) };
    if (Object.keys(patch).length > 0) onEdit(patch);
  };
  // Moving from the label input to the priority select must not end the edit, and iOS
  // doesn't always report relatedTarget, so check where focus landed a tick later.
  const onBlur = () =>
    setTimeout(() => {
      if (editBox.current && !editBox.current.contains(document.activeElement)) commit();
    }, 0);
  return (
    <li className={`log-row${running ? ' is-running' : ''}${editing ? ' is-editing' : ''}`}>
      <span className="log-time">
        {formatTime(s.startedAt)}
        {s.endedAt != null && <> – {formatTime(s.endedAt)}</>}
      </span>
      {editing ? (
        <span className="log-edit" ref={editBox} onBlur={onBlur}>
          <input
            className="input log-label-input"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // An input method's Enter picks a candidate and its Escape drops one: neither ends the edit.
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') setEditing(false);
            }}
            maxLength={LIMITS.sessionLabel}
            aria-label="Session label"
          />
          {planned.length > 0 && (
            <select
              className="input select log-plan-select"
              value={linked?.uid ?? ''}
              onChange={(e) => commit({ priorityUid: e.target.value || null })}
              aria-label="Priority this session was for"
            >
              <option value="">Unplanned</option>
              {planned.map((p) => (
                <option key={p.uid} value={p.uid!}>
                  {p.position} · {p.text}
                </option>
              ))}
            </select>
          )}
        </span>
      ) : (
        <button
          className="log-label"
          onClick={() => {
            setDraft(s.label);
            setEditing(true);
          }}
          title={linked ? `Priority ${linked.position}: ${linked.text}. Click to edit` : 'Edit label or link to a priority'}
        >
          {linked && (
            <span className="log-plan" role="img" aria-label={`Priority ${linked.position}`}>
              {linked.position}
            </span>
          )}
          {s.label || <span className="muted">{UNTITLED_SESSION}</span>}
        </button>
      )}
      <span className="log-duration">
        {running && <span className={`pill ${paused ? 'pill--warn' : 'pill--ok'}`}>{paused ? 'paused' : 'running'}</span>} {formatDuration(seconds)}
      </span>
      <button
        className="btn btn-icon log-delete"
        onClick={() => {
          if (window.confirm(CONFIRM.deleteSession)) onDelete();
        }}
        aria-label="Delete session"
        title="Delete"
        disabled={running}
      >
        <Trash />
      </button>
    </li>
  );
}
