import type { RetroPatch } from '../api';
import { useDebouncedDraft } from '../hooks/useDebouncedDraft';
import { RETRO_PROMPT } from '../lib/copy';
import { useTimeFormat } from '../hooks/useTimeFormat';
import { counted, formatDuration } from '../lib/format';
import { reviewDay } from '../lib/retro';
import { LIMITS } from '../../../shared/api.js';
import type { Priority, Session } from '../types';
import { Check } from './Icons';
import { PlanNext } from './PlanNext';
import { SessionLabel } from './SessionLabel';

interface Props {
  date: string;
  today: string;
  priorities: Priority[];
  sessions: Session[];
  note: string;
  reviewedAt: number | null;
  onChange: (patch: RetroPatch) => Promise<boolean>;
}

/**
 * Plan vs. actual for one day: each priority with the focus time logged against it,
 * the sessions that weren't on the plan, and a note on why. The note saves 800 ms after
 * the last keystroke or on blur; a note whose save fails stays in its box and goes again.
 * "Mark reviewed" ticks the day once the note has saved. Keyed by date in the sheet, so a
 * new day mounts with its own note.
 */
export function Retro({ date, today, priorities, sessions, note, reviewedAt, onChange }: Props) {
  const { formatTime } = useTimeFormat();
  const review = reviewDay(priorities, sessions);
  // A note typed back to `note` is sent too: `note` can hold a save still out, and a box let go
  // for matching it would follow the note back if that save fails.
  const { draft, edit, flush } = useDebouncedDraft(note, (value) => onChange({ note: value }), 800);

  // An empty day still gets the note and Mark reviewed: the retro alarm stays armed until the
  // day is reviewed, and its banner opens this card.
  const empty = review.total === 0 && review.unplanned.length === 0;

  return (
    <div className="retro">
      {empty && <p className="muted center">Write priorities and log a session or two, then this shows how the day lined up with the plan.</p>}

      {review.total > 0 && (
        <section className="retro-section">
          <h3 className="section-heading">
            Planned{' '}
            <span className="muted">
              {review.done} of {review.total} done
              {review.routines.total > 0 && ` · routines ${review.routines.done} of ${review.routines.total}`}
            </span>
          </h3>
          <ul>
            {review.planned.map(({ priority: p, focusedSeconds, sessions: n, addedMidDay }) => (
              <li key={p.uid ?? p.position} className={`retro-row${p.done ? ' is-done' : ''}`}>
                <span className={`retro-tick${p.done ? ' is-done' : ''}`} role="img" aria-label={p.done ? 'Done' : 'Not done'}>
                  {p.done && <Check />}
                </span>
                <span className="retro-text">
                  <span className="retro-num" aria-hidden="true">
                    {p.position}
                  </span>
                  {p.text}
                  {addedMidDay && p.addedAt != null && <span className="pill pill--warn inline-pill">added {formatTime(p.addedAt)}</span>}
                </span>
                <span className="retro-time">
                  {n > 0 ? (
                    <>
                      {formatDuration(focusedSeconds)} <span className="muted small">· {counted(n, 'session')}</span>
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
          <h3 className="section-heading">
            Not on the plan <span className="muted">{formatDuration(review.offPlanSeconds)}</span>
          </h3>
          <ul>
            {review.unplanned.map((s) => (
              <li key={s.id} className="retro-row retro-row--unplanned">
                <span className="retro-tick" aria-hidden="true" />
                <span className="retro-text">
                  <SessionLabel label={s.label} />
                  <span className="muted small retro-when"> {formatTime(s.startedAt)}</span>
                </span>
                <span className="retro-time">{formatDuration(s.durationSeconds)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!empty && (
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
      )}

      <label className="field">
        <span className="muted small">Why did the day go this way?</span>
        <textarea
          className="input retro-textarea"
          value={draft}
          placeholder={RETRO_PROMPT}
          rows={3}
          maxLength={LIMITS.retroNote}
          onChange={(e) => edit(e.target.value)}
          onBlur={() => void flush()}
        />
      </label>

      <div className="retro-foot">
        {reviewedAt != null ? (
          <>
            <span className="pill pill--ok">
              <Check /> Reviewed {formatTime(reviewedAt)}
            </span>
            <button className="btn btn-ghost" onClick={() => void onChange({ done: false })}>
              Undo
            </button>
          </>
        ) : (
          <button className="btn btn-primary" onClick={() => void flush().then((ok) => ok && onChange({ done: true }))}>
            <Check /> Mark reviewed
          </button>
        )}
      </div>

      {/* Only today's card offers a plan, since the next day is ahead. */}
      {date === today && <PlanNext today={today} priorities={priorities} />}
    </div>
  );
}
