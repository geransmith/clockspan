import { useState } from 'react';
import { useDayStore } from '../hooks/useDay';
import { formatDuration, formatTime } from '../lib/format';
import type { Session } from '../types';
import { Trash } from './Icons';

interface Props {
  date: string;
  sessions: Session[];
  now: number;
}

export function SessionLog({ date, sessions, now }: Props) {
  const store = useDayStore();
  const completed = sessions.filter((s) => s.status === 'completed');
  const total = completed.reduce((sum, s) => sum + (s.durationSeconds ?? 0), 0);

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
          <Row key={s.id} session={s} now={now} onLabel={(label) => void store.updateSession(s.id, { label })} onDelete={() => void store.removeSession(date, s.id)} />
        ))}
      </ul>
    </div>
  );
}

function Row({ session: s, now, onLabel, onDelete }: { session: Session; now: number; onLabel: (l: string) => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(s.label);
  const running = s.status === 'running';
  const seconds = running ? Math.floor((now - s.startedAt) / 1000) : (s.durationSeconds ?? 0);
  const commit = () => {
    setEditing(false);
    if (draft.trim() !== s.label) onLabel(draft.trim());
  };
  return (
    <li className={`log-row${running ? ' is-running' : ''}`}>
      <span className="log-time">
        {formatTime(s.startedAt)}
        {s.endedAt != null && <> – {formatTime(s.endedAt)}</>}
      </span>
      {editing ? (
        <input
          className="input log-label-input"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
          maxLength={200}
          aria-label="Session label"
        />
      ) : (
        <button
          className="log-label"
          onClick={() => {
            setDraft(s.label);
            setEditing(true);
          }}
          title="Edit label"
        >
          {s.label || <span className="muted">Untitled session</span>}
        </button>
      )}
      <span className="log-duration">
        {running && <span className="pill pill--ok">running</span>} {formatDuration(seconds)}
      </span>
      <button
        className="btn btn-icon log-delete"
        onClick={() => {
          if (window.confirm('Delete this session from the log?')) onDelete();
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
