import { useRef, useState, type KeyboardEvent } from 'react';
import { useCelebration, type Moment } from '../hooks/useCelebration';
import { useDay } from '../hooks/useDay';
import { useSettings } from '../hooks/useSettings';
import { unlockAudio } from '../lib/alerts';
import type { CategoryPick } from '../lib/board';
import { LOAD_FAILED, PLAN_NEXT } from '../lib/copy';
import { dayName } from '../lib/format';
import { nextWorkDay, planNext, sameItem, textSeed } from '../lib/plan';
import { carriesOver } from '../lib/priorities';
import { hasText } from '../../../shared/priorities.js';
import { LIMITS } from '../../../shared/api.js';
import type { Priority } from '../types';
import { Burst } from './Burst';
import { CategoryChip } from './CategoryChip';
import { Plus } from './Icons';
import { LoadFailed } from './LoadFailed';

interface Props {
  today: string;
  /** That day's priorities: the unticked one-offs are offered for the next day. A routine comes back on its own weekdays. */
  priorities: Priority[];
  /** The category chip's data: each row typed in gets a chip. Null (the board off) shows none. */
  pick: CategoryPick | null;
}

/**
 * The end of the retrospective: put what's left, and anything new, on the next work day's
 * list tonight, while it's fresh. The day only loads once the planner opens.
 */
export function PlanNext({ today, priorities, pick }: Props) {
  const { settings } = useSettings();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  // Cancel and Save take the planner away with focus inside it: focus goes back to the button that returns.
  const [returnFocus, setReturnFocus] = useState(false);
  // Rows put on the next day's list: a small burst from the line that says so.
  const [planned, setPlanned] = useState<Moment | null>(null);
  const { anchor, burst } = useCelebration<HTMLDivElement>(planned, 'planDone');
  const next = nextWorkDay(today, settings.showWeekends);
  const name = dayName(next, today, true);
  return (
    <div className="plan-next">
      {open && (
        <Planner
          date={next}
          name={name}
          candidates={priorities.filter(carriesOver)}
          pick={pick}
          onDone={(added) => {
            setOpen(false);
            setReturnFocus(true);
            setResult(added ? PLAN_NEXT.done(added, name) : PLAN_NEXT.nothing);
            if (added) setPlanned({});
          }}
          onCancel={() => {
            setOpen(false);
            setReturnFocus(true);
          }}
        />
      )}
      {/* Mounted while the planner is open too, so its status line exists before the result arrives. */}
      <div className="plan-next-foot" ref={anchor}>
        {!open && (
          <button
            className="btn btn-ghost"
            autoFocus={returnFocus}
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
      <Burst at={burst} />
    </div>
  );
}

function Planner({
  date,
  name,
  candidates,
  pick,
  onDone,
  onCancel,
}: {
  date: string;
  name: string;
  candidates: Priority[];
  pick: CategoryPick | null;
  onDone: (added: number) => void;
  onCancel: () => void;
}) {
  const { day, failed, store } = useDay(date);
  // Today's open rows start ticked: carrying them over is the usual answer. Held by uid, since
  // removing a row on the Priorities card (or on another device) renumbers the rest while this is open.
  const [picked, setPicked] = useState(() => new Set(candidates.map((p) => p.uid)));
  // The rows typed in, each with the category its chip set.
  const [extra, setExtra] = useState<{ text: string; categoryUid: string | null }[]>([]);
  const [draft, setDraft] = useState('');
  const box = useRef<HTMLInputElement>(null);
  // While the save is out nothing more can be typed, ticked, filed or cancelled: its answer closes the planner.
  const [busy, setBusy] = useState(false);
  const onList = day?.priorities.filter(hasText) ?? [];
  const already = onList.length;
  // A task already on that list (planned earlier tonight, or from another device) isn't offered again.
  const offered = candidates.filter((p) => !onList.some((q) => sameItem(q, p)));

  const addDraft = () => {
    if (draft.trim()) setExtra((x) => [...x, { text: draft.trim(), categoryUid: null }]);
    setDraft('');
  };
  const setCategory = (i: number, categoryUid: string | null) => setExtra((x) => x.map((e, j) => (j === i ? { ...e, categoryUid } : e)));
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
    // A row carried over is the same task, under its current name and category. What is still in
    // the box, never entered, has had no chip, so it goes with no category; so do the rows typed
    // in once the board is off, whose chips are gone.
    const seeds = [...offered.filter((p) => picked.has(p.uid)), ...extra.map((e) => textSeed(e.text, pick ? e.categoryUid : null)), textSeed(draft)];
    const { rows, added } = planNext(day.priorities, seeds);
    if (added === 0) {
      onDone(0);
      return;
    }
    setBusy(true);
    // A failed save raises the store's banner and puts the stored list back.
    const ok = await store.setPriorities(date, rows, day.priorities);
    setBusy(false);
    if (ok) onDone(added);
  };

  return (
    <div className="plan-next-editor">
      <h3 className="section-heading">
        {PLAN_NEXT.title(name)} {already > 0 && <span className="muted">{PLAN_NEXT.already(already)}</span>}
      </h3>
      {failed && (
        <LoadFailed
          title={LOAD_FAILED.title}
          onRetry={() => {
            // Try again goes once the day loads: the focus moves to the box first.
            box.current?.focus();
            void store.load(date);
          }}
        />
      )}
      {offered.length + extra.length > 0 && (
        <ul className="plan-next-list">
          {offered.map((p) => (
            <li key={p.uid}>
              <label className="inline-check">
                <input
                  type="checkbox"
                  className="checkbox"
                  checked={picked.has(p.uid)}
                  disabled={busy}
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
          {extra.map(({ text, categoryUid }, i) => (
            <li key={`extra-${i}`} className="plan-next-extra">
              <Plus /> <span className="plan-next-extra-text">{text}</span>
              {pick && <CategoryChip value={categoryUid} onChange={(uid) => setCategory(i, uid)} pick={pick} label={`Category for ${text}`} disabled={busy} />}
            </li>
          ))}
        </ul>
      )}
      <input
        ref={box}
        className="input"
        value={draft}
        disabled={busy}
        autoFocus
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
        <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}
