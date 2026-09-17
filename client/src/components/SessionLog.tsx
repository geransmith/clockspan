import { useRef, useState } from 'react';
import { useDayStore } from '../hooks/useDay';
import { CONFIRM } from '../lib/copy';
import { formatDuration, formatTime } from '../lib/format';
import type { Priority, Session } from '../types';
import { Trash } from './Icons';

interface Props {
  date: string;
  sessions: Session[];
  priorities: Priority[];
  now: number;
}

export function SessionLog({ date, sessions, priorities, now }: Props) {
  const store = useDayStore();
  const completed = sessions.filter((s) => s.status === 'completed');
  const total = completed.reduce((sum, s) => sum + (s.durationSeconds ?? 0), 0);
  const planned = priorities.filter((p) => p.uid && p.text.trim());

  if (sessions.length === 0) {
    return <p className="muted center">No focus sessions yet. Start one above and it will show up here.</p>;
  }

  return (
    <div className="log">
      <div className="log-total">
        <span className="muted">Total focused</span>
        <strong>{formatDuration(total)}</strong>
        <span className="muted">
          · {completed.length} session{completed.length === 1 ? '' : 's'}
        </span>
      </div>
      <ul className="log-list">
        {sessions.map((s) => (
          <Row
            key={s.id}
            session={s}
            now={now}
            planned={planned}
            onEdit={(patch) => void store.updateSession(s.id, patch)}
            onDelete={() => void store.removeSession(date, s.id)}
          />
        ))}
      </ul>
    </div>
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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(s.label);
  const editBox = useRef<HTMLSpanElement>(null);
  const running = s.status === 'running';
  const seconds = running ? Math.floor((now - s.startedAt) / 1000) : (s.durationSeconds ?? 0);
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
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') setEditing(false);
            }}
            maxLength={200}
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
            <span className="log-plan" aria-label={`Priority ${linked.position}`}>
              {linked.position}
            </span>
          )}
          {s.label || <span className="muted">Untitled session</span>}
        </button>
      )}
      <span className="log-duration">
        {running && <span className="pill pill--ok">running</span>} {formatDuration(seconds)}
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
