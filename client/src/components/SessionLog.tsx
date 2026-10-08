import { useEffect, useRef, useState } from 'react';
import type { SessionEdit } from '../api';
import { useDayStore } from '../hooks/useDay';
import { useTimer } from '../hooks/useTimer';
import { categoryOf, type CategoryPick } from '../lib/board';
import { CONFIRM } from '../lib/copy';
import { useTimeFormat } from '../hooks/useTimeFormat';
import { breakSeconds } from '../lib/breaks';
import { counted, formatDuration } from '../lib/format';
import { hasText } from '../../../shared/priorities.js';
import { focusOf, sessionCategory, sessionCategoryEdit, sessionName } from '../lib/retro';
import { timerView } from '../lib/timer';
import type { Break, Priority, Session } from '../types';
import { CategoryChip } from './CategoryChip';
import { CategoryDot } from './CategoryDot';
import { Trash } from './Icons';
import { LabelInput, SessionLabel } from './SessionLabel';

interface Props {
  date: string;
  isToday: boolean;
  sessions: Session[];
  breaks: Break[];
  priorities: Priority[];
  /** The category chip's data: a session on no written row can be given a category. Null (the board off) shows none. */
  pick?: CategoryPick | null;
  now: number;
}

type Entry = { at: number; session: Session } | { at: number; brk: Break };

export function SessionLog({ date, isToday, sessions, breaks, priorities, pick = null, now }: Props) {
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
    <div>
      <div className="log-total">
        <span className="muted">Total focused</span>
        <strong>{formatDuration(focus.seconds)}</strong>
        <span className="muted">· {counted(focus.count, 'session')}</span>
      </div>
      {breaks.length > 0 && (
        <div className="log-total">
          <span className="muted">On breaks</span>
          <strong>{formatDuration(rested)}</strong>
          <span className="muted">· {counted(breaks.length, 'break')}</span>
        </div>
      )}
      <ul>
        {entries.map((e) =>
          'session' in e ? (
            <Row
              key={`s${e.session.id}`}
              session={e.session}
              now={now}
              planned={planned}
              rows={priorities}
              pick={pick}
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

function DeleteButton({ label, question, disabled, onDelete }: { label: string; question: string; disabled: boolean; onDelete: () => void }) {
  return (
    <button
      className="btn btn-icon log-delete"
      onClick={() => {
        if (window.confirm(question)) onDelete();
      }}
      aria-label={label}
      title="Delete"
      disabled={disabled}
    >
      <Trash />
    </button>
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
      <span className="log-break-label">Break</span>
      <span className="log-duration">
        {running && <span className="pill pill--ok">on break</span>} {formatDuration(breakSeconds(b, now))}
      </span>
      <DeleteButton label="Delete break" question={CONFIRM.deleteBreak} disabled={running} onDelete={onDelete} />
    </li>
  );
}

function Row({
  session: s,
  now,
  planned,
  rows,
  pick,
  onEdit,
  onDelete,
}: {
  session: Session;
  now: number;
  planned: Priority[];
  /** The day's rows: what the session's name and category are read from. */
  rows: Priority[];
  pick: CategoryPick | null;
  onEdit: (patch: SessionEdit) => void;
  onDelete: () => void;
}) {
  const { formatTime } = useTimeFormat();
  // The edit box opened: 'label' for a session with no task (its label, the select and the chip),
  // 'link' for one with a task, which names it (the name as text, the select, and the chip while
  // the task is off the day's list).
  const [editing, setEditing] = useState<'label' | 'link' | null>(null);
  const [draft, setDraft] = useState('');
  // Set when a key or the select ends the edit, so focus goes back to the label; a blur leaves focus where it went.
  const [returnFocus, setReturnFocus] = useState(false);
  const editBox = useRef<HTMLSpanElement>(null);
  const blurCheck = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(blurCheck.current), []);
  const running = s.status === 'running';
  const paused = running && s.pausedAt != null;
  // A running row counts its focus so far, which holds still while paused.
  const seconds = running ? timerView(s, now).elapsedSeconds : s.durationSeconds;
  // On the plan: its task is a written row of the day.
  const linked = s.priorityUid ? planned.find((p) => p.uid === s.priorityUid) : undefined;
  const hasTask = s.priorityUid != null;
  // What it is called: its task's current name, else its label.
  const name = sessionName(s, rows);
  // A box opened for a session linked or unlinked since (on another device) closes, unsent.
  if (editing && (editing === 'link') !== hasTask) setEditing(null);
  // What the session counts under, when the board holds it.
  const category = pick ? categoryOf(pick.categories, sessionCategory(s, rows)) : undefined;
  // One PATCH per edit: label, link and category together, so two responses can't land out of order.
  // A label goes only for a session that stays off a written row: the select linking it to one
  // drops a label typed before it, since the row names it from then on.
  const commit = (extra: Pick<SessionEdit, 'priorityUid' | 'categoryUid'> = {}) => {
    setEditing(null);
    const label = editing === 'label' && !extra.priorityUid ? draft.trim() : s.label;
    const patch = { ...extra, ...(label !== s.label ? { label } : {}) };
    if (Object.keys(patch).length > 0) onEdit(patch);
  };
  // Moving from the label input to the priority select or the category chip (and its list)
  // must not end the edit, and iOS doesn't always report relatedTarget, so check where focus
  // landed a tick later. Only the last check runs: a press outside an open category list moves
  // the focus twice in one go (option to chip, chip to the press), and two checks would both
  // find it outside and send the edit twice.
  const onBlur = () => {
    clearTimeout(blurCheck.current);
    blurCheck.current = setTimeout(() => {
      if (editBox.current && !editBox.current.contains(document.activeElement)) commit();
    }, 0);
  };
  return (
    <li className={`log-row${running ? ' is-running' : ''}`}>
      <span className="log-time">
        {formatTime(s.startedAt)}
        {s.endedAt != null && <> – {formatTime(s.endedAt)}</>}
      </span>
      {editing ? (
        <span className="log-edit" ref={editBox} onBlur={onBlur}>
          {editing === 'label' ? (
            <LabelInput
              className="log-label-input"
              value={draft}
              onChange={setDraft}
              onSave={() => {
                setReturnFocus(true);
                commit();
              }}
              onDrop={() => {
                setReturnFocus(true);
                setEditing(null);
              }}
            />
          ) : (
            <span className="log-label">{name}</span>
          )}
          {planned.length > 0 && (
            <select
              className="input select log-plan-select"
              autoFocus={editing === 'link'}
              value={s.priorityUid ?? ''}
              onChange={(e) => {
                setReturnFocus(true);
                // Only the link: the server drops a category of its own, since the row decides from then on.
                commit({ priorityUid: e.target.value || null });
              }}
              aria-label="Priority this session was for"
            >
              <option value="">Unplanned</option>
              {/* A task taken off the day still names the session; Unplanned gives it a name of its own. */}
              {hasTask && !linked && <option value={s.priorityUid!}>{name}</option>}
              {planned.map((p) => (
                <option key={p.uid} value={p.uid!}>
                  {p.position} · {p.text}
                </option>
              ))}
            </select>
          )}
          {/* A session on a written row counts under the row's category, which the row's own chip sets. */}
          {pick && !linked && (
            <span className="log-edit-category">
              <CategoryChip
                value={category?.uid ?? null}
                onChange={(categoryUid) => {
                  setReturnFocus(true);
                  commit(sessionCategoryEdit(s, categoryUid));
                }}
                pick={pick}
                label="Category for this session"
              />
            </span>
          )}
        </span>
      ) : (
        <button
          className="log-label"
          autoFocus={returnFocus}
          onClick={() => {
            setDraft(s.label);
            setReturnFocus(false);
            setEditing(hasTask ? 'link' : 'label');
          }}
          title={
            linked
              ? `Priority ${linked.position}. Click to change the priority`
              : hasTask
                ? 'Change the priority'
                : pick
                  ? 'Edit label, priority or category'
                  : 'Edit label or link to a priority'
          }
        >
          {linked && (
            <span className="log-plan" role="img" aria-label={`Priority ${linked.position}`}>
              {linked.position}
            </span>
          )}
          {/* A planned row shows its priority's number instead, and the priority its category. */}
          {!linked && category && <CategoryDot color={category.color} label={category.name} />}
          <SessionLabel label={name} />
        </button>
      )}
      <span className="log-duration">
        {running && <span className={`pill ${paused ? 'pill--warn' : 'pill--ok'}`}>{paused ? 'paused' : 'running'}</span>} {formatDuration(seconds)}
      </span>
      <DeleteButton label="Delete session" question={CONFIRM.deleteSession} disabled={running} onDelete={onDelete} />
    </li>
  );
}
