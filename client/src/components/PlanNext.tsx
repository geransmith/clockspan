import { useState, type KeyboardEvent } from 'react';
import { useCelebration, type Moment } from '../hooks/useCelebration';
import { useDay } from '../hooks/useDay';
import { useSettings } from '../hooks/useSettings';
import { unlockAudio } from '../lib/alerts';
import { LOAD_FAILED, PLAN_NEXT } from '../lib/copy';
import { dayName, sameText } from '../lib/format';
import { nextWorkDay, planNext } from '../lib/plan';
import { hasText } from '../lib/priorities';
import { LIMITS, type Priority } from '../types';
import { Burst } from './Burst';
import { Plus } from './Icons';
import { LoadFailed } from './LoadFailed';

interface Props {
  /** The day the retrospective is for; only today's offers a plan, since the next day is ahead. */
  date: string;
  today: string;
  /** That day's priorities: the unticked ones are offered for the next day. */
  priorities: Priority[];
}

/**
 * The end of the retrospective: put what's left, and anything new, on the next work day's
 * list tonight, while it's fresh. The day only loads once the planner opens.
 */
export function PlanNext({ date, today, priorities }: Props) {
  const { settings } = useSettings();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  // Rows put on the next day's list: a small burst from the line that says so.
  const [planned, setPlanned] = useState<Moment | null>(null);
  const { anchor, burst } = useCelebration<HTMLDivElement>(planned, 'planDone');
  const next = nextWorkDay(date, settings.showWeekends);
  if (date !== today) return null;
  const name = dayName(next, today, true);
  return (
    <div className="plan-next">
      {open && (
        <Planner
          date={next}
          name={name}
          candidates={priorities.filter((p) => hasText(p) && !p.done)}
          onDone={(message, added) => {
            setOpen(false);
            setResult(message);
            if (added > 0) setPlanned({});
          }}
          onCancel={() => setOpen(false)}
        />
      )}
      {/* Mounted while the planner is open too, so its status line exists before the result arrives. */}
      <div className="plan-next-foot" ref={anchor}>
        {!open && (
          <button
            className="btn btn-ghost"
            onClick={() => {
              setResult(null);
              setOpen(true);
            }}
          >
            {PLAN_NEXT.open(name)}
          </button>
        )}
        <span className="muted small" role="status">
          {result}
        </span>
      </div>
      {burst && <Burst key={burst.seed} seed={burst.seed} anchor={burst.anchor} />}
    </div>
  );
}

function Planner({
  date,
  name,
  candidates,
  onDone,
  onCancel,
}: {
  date: string;
  name: string;
  candidates: Priority[];
  onDone: (message: string, added: number) => void;
  onCancel: () => void;
}) {
  const { day, failed, store } = useDay(date);
  // Today's open rows start ticked: carrying them over is the usual answer. Held by uid, since
  // removing a row on the Priorities card (or on another device) renumbers the rest while this is open.
  const [picked, setPicked] = useState(() => new Set(candidates.map((p) => p.uid)));
  const [extra, setExtra] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const onList = day?.priorities.filter(hasText) ?? [];
  const already = onList.length;
  // A row already on that list (planned earlier tonight) isn't offered again.
  const planned = new Set(onList.map((p) => sameText(p.text)));
  const offered = candidates.filter((p) => !planned.has(sameText(p.text)));

  const addDraft = () => {
    if (draft.trim()) setExtra((x) => [...x, draft.trim()]);
    setDraft('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      addDraft();
    }
  };
  const save = async () => {
    if (!day) return;
    // The tap is the gesture iOS needs: the "next day planned" sound plays after the save answers.
    unlockAudio();
    const texts = [...offered.filter((p) => picked.has(p.uid)).map((p) => p.text), ...extra, ...(draft.trim() ? [draft] : [])];
    const { rows, added } = planNext(day.priorities, texts);
    if (added === 0) {
      onDone(PLAN_NEXT.nothing, 0);
      return;
    }
    setBusy(true);
    // A failed save raises the store's banner and puts the stored list back.
    const ok = await store.setPriorities(date, rows);
    setBusy(false);
    if (ok) onDone(PLAN_NEXT.done(added, name), added);
  };

  return (
    <div className="plan-next-editor">
      <h3 className="retro-heading">
        {PLAN_NEXT.title(name)} {already > 0 && <span className="muted">{PLAN_NEXT.already(already)}</span>}
      </h3>
      {failed && <LoadFailed title={LOAD_FAILED.title} onRetry={() => void store.load(date)} />}
      {offered.length + extra.length > 0 && (
        <ul className="plan-next-list">
          {offered.map((p) => (
            <li key={p.uid}>
              <label className="inline-check">
                <input
                  type="checkbox"
                  className="checkbox"
                  checked={picked.has(p.uid)}
                  onChange={(e) =>
                    setPicked((s) => {
                      const nextSet = new Set(s);
                      if (e.target.checked) nextSet.add(p.uid);
                      else nextSet.delete(p.uid);
                      return nextSet;
                    })
                  }
                />
                <span>{p.text}</span>
              </label>
            </li>
          ))}
          {extra.map((text, i) => (
            <li key={`extra-${i}`} className="plan-next-extra">
              <Plus /> <span>{text}</span>
            </li>
          ))}
        </ul>
      )}
      <input
        className="input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        placeholder={PLAN_NEXT.placeholder}
        maxLength={LIMITS.priorityText}
        aria-label={PLAN_NEXT.placeholder}
      />
      <div className="retro-foot">
        <button className="btn btn-primary" onClick={() => void save()} disabled={busy || !day}>
          {PLAN_NEXT.save(name)}
        </button>
        <button className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
