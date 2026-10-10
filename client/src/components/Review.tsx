import { useRef, type ReactNode } from 'react';
import { useBoardState } from '../hooks/useBoard';
import { useRange } from '../hooks/useRange';
import { useSettings } from '../hooks/useSettings';
import { categoryOf } from '../lib/board';
import { LOAD_FAILED } from '../lib/copy';
import { counted, formatDateLong, formatDuration, formatWeekday } from '../lib/format';
import { PERIOD_KINDS, periodRange, periodTarget, reviewRange, type CategoryTime, type PeriodKind, type ReviewPeriod } from '../lib/review';
import type { Category, Day } from '../types';
import { CategoryDot } from './CategoryDot';
import { Folded } from './Folded';
import { Check } from './Icons';
import { LoadFailed } from './LoadFailed';
import { PeriodNav } from './PeriodNav';
import { SessionLabel } from './SessionLabel';
import { Tile } from './Tile';

const PERIOD_LABELS: Record<PeriodKind, string> = { week: 'Week', month: 'Month', quarter: 'Quarter' };

interface Props {
  today: string;
  now: number;
  /**
   * Owned by History so the calendar's "Review this week" can point it at a week. A day opened
   * from here takes the period along, so Back reopens the review on it.
   */
  period: ReviewPeriod;
  onPeriod: (next: ReviewPeriod) => void;
  onOpen: (date: string) => void;
}

/**
 * The daily retrospectives rolled up: how the period's time split between the plan and
 * everything else (and by category), how often each routine got done, which one-offs never did,
 * and each day's note on why.
 */
export function Review({ today, now, period: { kind, from }, onPeriod, onOpen }: Props) {
  const period = periodRange(kind, from, 0);
  const { days, failed, retry } = useRange(period.from, period.to);
  // Try again goes as the loading block takes its place: ◀ takes the focus.
  const prevRef = useRef<HTMLButtonElement>(null);
  const tryAgain = () => {
    prevRef.current?.focus();
    retry();
  };

  // Another kind is taken around the period on screen, by its last day or today if that comes
  // first, so a past week becomes its month and the current period stays the current one.
  const pickKind = (k: PeriodKind) => onPeriod({ kind: k, from: periodRange(k, period.to < today ? period.to : today, 0).from });

  return (
    <section className="card review">
      <header className="card-head">
        <h2 className="card-title">Review</h2>
        <span className="chips" role="group" aria-label="Period">
          {PERIOD_KINDS.map((k) => (
            <button key={k} className="chip" onClick={() => pickKind(k)} aria-pressed={kind === k}>
              {PERIOD_LABELS[k]}
            </button>
          ))}
        </span>
      </header>
      <PeriodNav kind={kind} label={period.label} from={period.from} today={today} onFrom={(f) => onPeriod({ kind, from: f })} prevRef={prevRef} />

      {failed ? <LoadFailed title={LOAD_FAILED.range} onRetry={tryAgain} /> : !days && <div className="loading" aria-busy="true" />}
      {days && <Body key={`${kind}:${period.from}`} days={days} today={today} now={now} kind={kind} onOpen={onOpen} />}
    </section>
  );
}

function Body({ days, today, now, kind, onOpen }: { days: Day[]; today: string; now: number; kind: PeriodKind; onOpen: (date: string) => void }) {
  const { settings } = useSettings();
  const { board } = useBoardState();
  // Before the board's first read answers, nothing is counted under a category, and Not done
  // knows no task's lane. A removed category stays known, so the time logged under it keeps its
  // name. A done task keeps its lane but shows in Done, and the board stops sending it after a
  // while, so only the open ones count as laned.
  const categories = board?.categories ?? [];
  const known = new Set(categories.map((c) => c.uid));
  const laned = new Set(board?.cards.filter((c) => c.lane != null && !c.listDone).map((c) => c.uid));
  const r = reviewRange(days, settings, today, now, known, laned);
  if (r.days === 0) return <p className="muted center review-empty">Nothing recorded.</p>;
  // A row merged across days names them in a week and counts them in a longer period; it
  // opens the latest of them.
  const when = (dates: string[]) => {
    if (kind === 'week') return dates.map(formatWeekday).join(', ');
    return dates.length === 1 ? formatDateLong(dates[0]!) : `${dates.length} days`;
  };
  const latest = (dates: string[]) => dates[dates.length - 1]!;

  const target = periodTarget(kind, r, settings.weekMinutes);
  // A third of a phone fits a few words a line: keep each duration whole ("40h 00m", not "40h / 00m").
  const whole = (seconds: number) => formatDuration(seconds).replaceAll(' ', '\u00a0');
  const worked = `worked ${whole(r.workedSeconds)}${target > 0 ? ` of ${whole(target)}` : ''}`;
  // A session finished within its first second logs no time, so there can be sessions and no share.
  const sessions = counted(r.sessions, 'session') + (r.onPlanPercent == null ? '' : ` · ${r.onPlanPercent}% on plan`);
  const typical = kind === 'quarter' ? null : r.typicalDay;
  const mostly = categoryOf(categories, r.midDay.categoryUid);
  const facts: { label: string; value: string }[] = [];
  if (r.midDay.added > 0) facts.push({ label: 'Added mid-day', value: `${r.midDay.added} · ${r.midDay.done} done${mostly ? ` · mostly ${mostly.name}` : ''}` });
  if (r.breaks.count > 0) facts.push({ label: 'Breaks', value: `${r.breaks.count} · ${formatDuration(r.breaks.seconds)}` });
  if (typical) facts.push({ label: 'Typical day', value: `${typical.planned} planned · ${typical.done} done` });

  return (
    <div className="review-body">
      <div className="tiles">
        <Tile label="Days" value={String(r.days)} sub={settings.trackHours ? worked : ''} />
        <Tile label="Focused" value={formatDuration(r.focusedSeconds)} sub={r.sessions === 0 ? 'no sessions' : sessions} />
        <Tile
          label="Priorities"
          value={r.prioritiesTotal > 0 ? `${r.prioritiesDone}/${r.prioritiesTotal}` : '—'}
          sub={`${r.retrosDone} of ${r.days} reviewed`}
        />
      </div>

      {facts.length > 0 && (
        <ul className="review-facts">
          {facts.map((f) => (
            <li key={f.label}>
              <span className="muted">{f.label}:</span> <strong>{f.value}</strong>
            </li>
          ))}
        </ul>
      )}

      {r.byCategory.some((c) => c.categoryUid != null) && <ByCategory byCategory={r.byCategory} categories={categories} />}

      <section className="review-section">
        <h3 className="section-heading">
          Off the plan <span className="muted">{formatDuration(r.offPlanSeconds)}</span>
        </h3>
        {r.unplanned.length === 0 ? (
          <p className="muted small">{r.sessions === 0 ? 'No sessions logged.' : 'Every logged session was for a priority.'}</p>
        ) : (
          <Folded
            className="review-list"
            items={r.unplanned.map((g) => (
              <ReviewRow key={g.key} text={<SessionLabel label={g.label} />} meta={when(g.dates)} seconds={g.seconds} onOpen={() => onOpen(latest(g.dates))} />
            ))}
          />
        )}
      </section>

      {r.routines.length > 0 && (
        <section className="review-section">
          <h3 className="section-heading">
            Routines <span className="muted">{r.routines.length}</span>
          </h3>
          <Folded
            className="review-list"
            items={r.routines.map((g) => (
              <ReviewRow
                key={g.uid}
                text={g.title}
                meta={`${g.done} of ${counted(g.dates.length, 'day')}`}
                seconds={g.focusedSeconds}
                onOpen={() => onOpen(latest(g.dates))}
              />
            ))}
          />
        </section>
      )}

      <section className="review-section">
        <h3 className="section-heading">
          Not done <span className="muted">{r.notDone.length}</span>
        </h3>
        {r.notDone.length === 0 ? (
          <p className="muted small">
            {r.routines.length > 0
              ? 'Nothing outside the routines was left open.'
              : r.prioritiesTotal > 0
                ? 'Every priority got ticked.'
                : 'No priorities were written.'}
          </p>
        ) : (
          <Folded
            className="review-list"
            items={r.notDone.map((g) => (
              <ReviewRow
                key={g.key}
                text={
                  <>
                    {g.text}
                    {g.addedMidDay && <span className="pill pill--warn inline-pill">mid-day</span>}
                  </>
                }
                meta={when(g.dates)}
                seconds={g.focusedSeconds}
                onOpen={() => onOpen(latest(g.dates))}
              />
            ))}
          />
        )}
      </section>

      <section className="review-section">
        <h3 className="section-heading">Why</h3>
        {r.notes.length === 0 ? (
          <p className="muted small">No retrospective notes yet. Each day's retrospective card is where they go.</p>
        ) : (
          <Folded
            className="review-list"
            items={r.notes.map((n) => (
              <li key={n.date}>
                <button className="review-row review-row--note" onClick={() => onOpen(n.date)}>
                  <span className="review-meta review-note-head">
                    <strong>{formatDateLong(n.date)}</strong>
                    {n.reviewedAt != null && (
                      <span className="pill pill--ok">
                        <Check /> reviewed
                      </span>
                    )}
                  </span>
                  <span className="review-note">{n.note}</span>
                </button>
              </li>
            ))}
          />
        )}
      </section>
    </div>
  );
}

const time = (seconds: number) => (seconds > 0 ? formatDuration(seconds) : <span className="muted">no time</span>);

/** A row of Off the plan, Routines or Not done: what it is, when, its time, and a press opens its latest day. */
function ReviewRow({ text, meta, seconds, onOpen }: { text: ReactNode; meta: string; seconds: number; onOpen: () => void }) {
  return (
    <li>
      <button className="review-row" onClick={onOpen}>
        <span className="review-text">{text}</span>
        <span className="review-meta">
          <span className="muted small">{meta}</span>
          <span className="review-time">{time(seconds)}</span>
        </span>
      </button>
    </li>
  );
}

/**
 * Each category's focus as a bar against the period's largest, the part on a priority solid and
 * the part off the plan striped in the same colour; the row's text says all the bar does.
 * Its rows open no day: a category's time is spread over many.
 */
function ByCategory({ byCategory, categories }: { byCategory: CategoryTime[]; categories: Category[] }) {
  const longest = Math.max(...byCategory.map((c) => c.seconds));
  const share = (part: number, whole: number) => `${(part / whole) * 100}%`;
  return (
    <section className="review-section">
      <h3 className="section-heading">By category</h3>
      <Folded
        className="review-list"
        items={byCategory.map((c) => {
          // A listed uid is one of the board's, so this misses only for none.
          const cat = categoryOf(categories, c.categoryUid);
          const onPlan = c.seconds - c.offPlanSeconds;
          return (
            <li key={c.categoryUid ?? 'none'} className="review-category">
              {cat && <CategoryDot color={cat.color} />}
              <span className="review-text">{cat ? cat.name : 'No category'}</span>
              {(c.offPlanSeconds >= 60 || c.done > 0) && (
                <span className="review-category-parts">
                  {c.offPlanSeconds >= 60 && <span className="muted small">{formatDuration(c.offPlanSeconds)} off the plan</span>}
                  {c.done > 0 && <span className="muted small">{c.done} done</span>}
                </span>
              )}
              <span className="review-time">{time(c.seconds)}</span>
              {c.seconds > 0 && (
                <span className="category-bar" data-color={cat?.color} aria-hidden="true" style={{ width: share(c.seconds, longest) }}>
                  {onPlan > 0 && <span className="category-bar-on" style={{ width: share(onPlan, c.seconds) }} />}
                  {c.offPlanSeconds > 0 && <span className="category-bar-off" style={{ width: share(c.offPlanSeconds, c.seconds) }} />}
                </span>
              )}
            </li>
          );
        })}
      />
    </section>
  );
}
