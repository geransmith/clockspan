import { useEffect, useRef, useState } from 'react';
import { RETRO_PROMPT } from '../lib/copy';
import { formatDuration, formatTime } from '../lib/format';
import { reviewDay } from '../lib/retro';
import type { Priority, Session } from '../types';
import { Check } from './Icons';

interface Props {
  date: string;
  priorities: Priority[];
  sessions: Session[];
  note: string;
  reviewedAt: number | null;
  onChange: (patch: { note?: string; done?: boolean }) => void;
}

/**
 * Plan vs. actual for one day: each priority with the focus time logged against it,
 * the sessions that weren't on the plan, and a note on why. The note saves 800 ms after
 * the last keystroke or on blur; "Mark reviewed" saves immediately.
 */
export function Retro({ date, priorities, sessions, note, reviewedAt, onChange }: Props) {
  const review = reviewDay(priorities, sessions);
  const [draft, setDraft] = useState(note);
  const dirty = useRef(false);
  const timer = useRef<number | null>(null);

  // Adopt the stored note when the day changes or when nothing is being typed.
  useEffect(() => {
    if (!dirty.current) setDraft(note);
  }, [note]);
  useEffect(() => {
    dirty.current = false;
    setDraft(note);
  }, [date]);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const flush = (value: string) => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    if (!dirty.current) return;
    dirty.current = false;
    if (value !== note) onChange({ note: value });
  };
  const edit = (value: string) => {
    setDraft(value);
    dirty.current = true;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => flush(value), 800);
  };

  if (review.total === 0 && review.unplanned.length === 0) {
    return <p className="muted center">Write priorities and log a session or two, then this shows how the day lined up with the plan.</p>;
  }

  const offPlan = review.unplanned.reduce((sum, s) => sum + (s.durationSeconds ?? 0), 0);

  return (
    <div className="retro">
      {review.total > 0 && (
        <section className="retro-section">
          <h3 className="retro-heading">
            Planned <span className="muted">{review.done} of {review.total} done</span>
          </h3>
          <ul className="retro-list">
            {review.planned.map(({ priority: p, focusedSeconds, sessions: n, addedMidDay }) => (
              <li key={p.uid ?? p.position} className={`retro-row${p.done ? ' is-done' : ''}`}>
                <span className={`retro-tick${p.done ? ' is-done' : ''}`} aria-label={p.done ? 'Done' : 'Not done'}>
                  {p.done && <Check />}
                </span>
                <span className="retro-text">
                  <span className="retro-num" aria-hidden="true">
                    {p.position}
                  </span>
                  {p.text}
                  {addedMidDay && p.addedAt != null && <span className="pill pill--warn retro-late">added {formatTime(p.addedAt)}</span>}
                </span>
                <span className="retro-time">
                  {n > 0 ? (
                    <>
                      {formatDuration(focusedSeconds)} <span className="muted small">· {n === 1 ? '1 session' : `${n} sessions`}</span>
                    </>
                  ) : (
                    <span className="muted">no time logged</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {review.unplanned.length > 0 && (
        <section className="retro-section">
          <h3 className="retro-heading">
            Not on the plan <span className="muted">{formatDuration(offPlan)}</span>
          </h3>
          <ul className="retro-list">
            {review.unplanned.map((s) => (
              <li key={s.id} className="retro-row retro-row--unplanned">
                <span className="retro-tick" aria-hidden="true" />
                <span className="retro-text">
                  {s.label || <span className="muted">Untitled session</span>}
                  <span className="muted small retro-when"> {formatTime(s.startedAt)}</span>
                </span>
                <span className="retro-time">{formatDuration(s.durationSeconds ?? 0)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="retro-summary">
        <span>
          <span className="muted">On plan</span> <strong>{formatDuration(review.onPlanSeconds)}</strong>
        </span>
        <span>
          <span className="muted">Off plan</span> <strong>{formatDuration(review.offPlanSeconds)}</strong>
        </span>
        {review.total > 0 && (
          <span>
            <span className="muted">Done</span>{' '}
            <strong>
              {review.done} of {review.total}
            </strong>
          </span>
        )}
      </p>

      <label className="field retro-note">
        <span className="muted small">Why did the day go this way?</span>
        <textarea
          className="input retro-textarea"
          value={draft}
          placeholder={RETRO_PROMPT}
          rows={3}
          maxLength={4000}
          onChange={(e) => edit(e.target.value)}
          onBlur={() => flush(draft)}
        />
      </label>

      <div className="retro-foot">
        {reviewedAt != null ? (
          <>
            <span className="pill pill--ok">
              <Check /> Reviewed {formatTime(reviewedAt)}
            </span>
            <button className="btn btn-ghost" onClick={() => onChange({ done: false })}>
              Undo
            </button>
          </>
        ) : (
          <button
            className="btn btn-primary"
            onClick={() => {
              flush(draft);
              onChange({ done: true });
            }}
          >
            <Check /> Mark reviewed
          </button>
        )}
      </div>
    </div>
  );
}
