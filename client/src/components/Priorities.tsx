import { Fragment, useId, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useCelebration, type Moment } from '../hooks/useCelebration';
import { useDebouncedDraft } from '../hooks/useDebouncedDraft';
import { useSettings } from '../hooks/useSettings';
import { unlockAudio, warnQuietly } from '../lib/alerts';
import type { CategoryPick } from '../lib/board';
import { BLANK_NOTE, LEFT_OPEN, RENAME_NOTE, SAVE_FAILED, WARNING_ACTIONS } from '../lib/copy';
import { formatDurationCeil } from '../lib/format';
import { planNext, type PrioritySeed } from '../lib/plan';
import {
  clearRow,
  editPriority,
  emptyRow,
  isOneOff,
  isRecurring,
  nudgeFor,
  padPriorities,
  pickWarning,
  removePriority,
  type WarningKind,
} from '../lib/priorities';
import { acceptOffer, notOnList } from '../lib/recurring';
import { loggedByUid } from '../lib/retro';
import { hasText, isFree } from '../../../shared/priorities.js';
import { LIMITS } from '../../../shared/api.js';
import { MAX_PRIORITIES } from '../../../shared/settings.js';
import type { Priority, Recurring, Session } from '../types';
import { Burst } from './Burst';
import { CategoryChip } from './CategoryChip';
import { Check, Plus, X } from './Icons';
import { RemoveTask } from './RemoveTask';
import { RepeatMark } from './RepeatMark';
import { TodayOffer, type MorningOffer } from './TodayOffer';

interface Props {
  priorities: Priority[];
  /** The day's sessions: × asks first about a task with time logged on it, one finished since the day was read included. */
  sessions: Session[];
  /** `base`: the rows the edits were made on, the list the card last sent or last took up from `priorities`. */
  onChange: (priorities: Priority[], base: Priority[]) => void;
  /** Deletes a task everywhere (the board store's `deleteItem`), for ×'s Delete everywhere; rejects when that fails. */
  onDeleteTask: (uid: string) => Promise<void>;
  /** The category chip's data: each row with text gets a chip. Null (the board off) shows none. */
  pick?: CategoryPick | null;
  /**
   * With the board off, what the last planned day left unticked (`from` names that day), offered
   * while the list has no one-off written (a routine on it doesn't count): its rows as seeds.
   */
  leftOpen?: { from: string; rows: PrioritySeed[]; dismiss: () => void } | null;
  /**
   * With the board on, today's morning notice in place of `leftOpen`: the leftovers while the list
   * has no one-off written, and the routines due today that no row holds yet.
   */
  offer?: MorningOffer | null;
}

/** The first row of `after` the change filled: one with a task that `before` didn't hold. */
const firstFilled = (before: Priority[], after: Priority[]) => after.find((p) => p.uid != null && !before.some((q) => q.uid === p.uid));

/** A row whose box was emptied: its task's name isn't saved blank, and comes back when the box is left. */
const isBlank = (p: Priority) => p.uid != null && !hasText(p);

/**
 * The list as it may be saved: a blank row goes with the name it was built on (`base`), or as a
 * free row when it never had one (typed and emptied before it was saved).
 */
function named(list: Priority[], base: Priority[]): Priority[] {
  return list.map((p) => {
    if (!isBlank(p)) return p;
    const was = base.find((b) => b.uid === p.uid);
    return was ? { ...p, text: was.text } : emptyRow(p.position);
  });
}

/** What ×'s question needs: the task, and how many other days and how much time it would ask about. */
interface Asked {
  uid: string;
  name: string;
  otherDays: number;
  logged: number;
}

/**
 * Starts with `priorityCount` rows and grows on demand. Text saves 400 ms after the last
 * keystroke; checkboxes, add and remove save immediately. Keyed by date in the sheet, so a
 * new day mounts fresh instead of carrying drafts over.
 */
export function Priorities({ priorities, sessions, onChange, onDeleteTask, pick = null, leftOpen, offer }: Props) {
  const { settings } = useSettings();
  const count = settings.priorityCount;
  const stored = useMemo(() => padPriorities(priorities, count), [priorities, count]);
  // Let go once sent: a list held after a failed save would stop the card following the stored
  // list (a row the timer's "Also add to today's priorities" or another device added, a tick
  // made elsewhere) until a later save went through. A failed row goes back to the stored copy,
  // with the banner. A blank name is the exception: the other rows' changes go, the name goes as
  // it was, and the draft is held, so the box stays empty until it is left rather than taking the
  // stored name back while it has the focus.
  const sendList = (list: Priority[], base: Priority[]) => {
    onChange(named(list, base), base);
    return !list.some(isBlank);
  };
  const { draft: local, edit: editList, flush } = useDebouncedDraft(stored, sendList, 400);
  const [warning, setWarning] = useState<{ kind: WarningKind; text: string } | null>(null);
  const lastWarning = useRef<string | undefined>(undefined);
  const inputs = useRef(new Map<number, HTMLTextAreaElement>());
  // Where focus goes when the button that had it is taken away, so a keyboard user isn't sent back to the page's top.
  const addButton = useRef<HTMLButtonElement>(null);
  // A tick gets a burst from its checkbox.
  const [ticked, setTicked] = useState<Moment | null>(null);
  const { anchor, burst } = useCelebration<HTMLInputElement>(ticked, 'priorityDone');
  const logged = useMemo(() => loggedByUid(sessions), [sessions]);
  const noteId = useId();
  // The row whose box has the focus, by its place (its key), and its text then: the rename note
  // compares with it. A free row's task is minted by its first key, so its uid at focus can't say.
  const [focused, setFocused] = useState<{ position: number; text: string } | null>(null);
  const [asked, setAsked] = useState<Asked | null>(null);
  const storedName = (uid: string | null) => stored.find((q) => q.uid === uid)?.text;

  const edit = (position: number, patch: Partial<Priority>, now = false) => {
    editList(
      local.map((p) => (p.position === position ? editPriority(p, patch, Date.now()) : p)),
      now,
    );
  };
  const doneRows = local.filter((p) => p.done);
  const done = doneRows.length;
  const total = local.filter(hasText).length;
  // The leftovers are offered while no one-off is written: a routine on the list is no plan.
  const noOneOff = !local.some(isOneOff);
  // The morning notice's groups, judged again on the draft (the sheet judged the stored list), so
  // a row typed or a save already sent counts at once.
  const offerLeftovers = offer?.leftovers && noOneOff ? offer.leftovers : null;
  const offerRecurring = offer ? notOnList(offer.recurring, local) : [];

  const addRow = (force = false) => {
    // A free row is where a new priority goes, with no nudge: the nudge is about a written list.
    // A blank box is still its task's row, and is passed. Focusing the row inside the tap is what
    // lets iOS raise the keyboard.
    const free = local.find(isFree);
    if (free) {
      setWarning(null);
      inputs.current.get(free.position)?.focus();
      return;
    }
    if (local.length >= MAX_PRIORITIES) return;
    const kind = force ? null : nudgeFor(local, count);
    if (kind) {
      const w = pickWarning(kind, lastWarning.current);
      lastWarning.current = w;
      setWarning({ kind, text: w });
      return;
    }
    setWarning(null);
    const next = [...local, emptyRow(local.length + 1)];
    // Rendered at once, so the new row is there to take focus inside the same tap.
    flushSync(() => editList(next, true));
    inputs.current.get(next.length)?.focus();
  };
  // Focus goes where Add priority would put a new priority.
  const focusFree = (rows = local) => {
    const free = rows.find(isFree);
    if (free) inputs.current.get(free.position)?.focus();
    else addButton.current?.focus();
  };
  // Rendered at once, so focus can go to the first row the offer filled inside the same tap; a
  // routine already on the list may sit ahead of it (`planNext` keeps written rows first). With
  // nothing filled (every item a repeat, or none ticked) the focus goes where a new priority would.
  const fill = (next: Priority[]) => {
    flushSync(() => editList(next, true));
    const first = firstFilled(local, next);
    if (first) inputs.current.get(first.position)?.focus();
    else focusFree(next);
  };
  // Each row brings its own task over, added to today now, so the retro counts it as planned
  // unless a session ran first. A task the list holds already isn't added twice.
  const bringOver = (rows: PrioritySeed[]) => fill(padPriorities(planNext(local, rows).rows, count));
  const dismissLeftOpen = (dismiss: () => void) => {
    dismiss();
    focusFree();
  };
  // The routines go after the padded rows, which stay free for one-offs (`acceptOffer`). Every
  // item shown is answered, ticked or not, so the notice doesn't come back for it today, even
  // when a row it added is removed.
  const answerOffer = (answer: MorningOffer['answer']) =>
    answer(
      offerRecurring.map((r) => r.uid),
      offerLeftovers !== null,
    );
  const acceptToday = (answer: MorningOffer['answer'], seeds: PrioritySeed[], recurring: Recurring[]) => {
    fill(acceptOffer(local, count, seeds, recurring, Date.now()));
    answerOffer(answer);
  };
  const skipToday = (answer: MorningOffer['answer']) => {
    answerOffer(answer);
    focusFree();
  };
  const removeRow = (position: number) => {
    // Removing a row before the last moves the next row's X under focus; the last row takes its X with it.
    flushSync(() => editList(removePriority(local, position), true));
    if (position === local.length) addButton.current?.focus();
  };
  // Within Rows per day the row stays, free, with the focus in its box; past that it goes.
  const takeOff = (position: number) => {
    if (position > count) return removeRow(position);
    flushSync(() => editList(clearRow(local, position), true));
    inputs.current.get(position)?.focus();
  };
  // × asks first when the task is on other days or has time logged on it, since Delete everywhere
  // is then a different answer; a recurring priority's row never asks (Settings removes those).
  const remove = (p: Priority) => {
    const time = p.uid == null ? 0 : Math.max(p.logged, logged.get(p.uid) ?? 0);
    if (p.uid != null && !isRecurring(p) && (p.listed > 1 || time > 0)) {
      setAsked({ uid: p.uid, name: hasText(p) ? p.text : (storedName(p.uid) ?? ''), otherDays: Math.max(0, p.listed - 1), logged: time });
    } else takeOff(p.position);
  };
  // The dialog goes first, so the focus it gives back to × moves on from there.
  const answer = (everywhere: boolean) => {
    const ask = asked!;
    flushSync(() => setAsked(null));
    const row = local.find((p) => p.uid === ask.uid);
    if (row) takeOff(row.position);
    // The day's save without the row has gone out first; a failed delete leaves the task off this day only.
    if (everywhere) void onDeleteTask(ask.uid).catch(() => warnQuietly({ ...SAVE_FAILED, tag: 'save-failed' }));
  };
  // The blank box's name back: the task's as stored, or a free row for one never saved.
  const restore = (p: Priority) => {
    const name = storedName(p.uid);
    editList(
      local.map((q) => (q.position === p.position ? (name ? { ...q, text: name } : emptyRow(q.position)) : q)),
      true,
    );
  };
  const keepList = () => {
    setWarning(null);
    addButton.current?.focus();
  };

  return (
    <div className="priorities">
      {offer && (offerLeftovers || offerRecurring.length > 0) && (
        <TodayOffer
          leftovers={offerLeftovers}
          recurring={offerRecurring}
          rows={local}
          perDay={settings.recurringPerDay}
          onAdd={(seeds, recurring) => acceptToday(offer.answer, seeds, recurring)}
          onSkip={() => skipToday(offer.answer)}
        />
      )}
      {leftOpen && noOneOff && (
        <div className="notice notice--gentle left-open">
          <div className="left-open-list">
            <strong>{LEFT_OPEN.title(leftOpen.from)}</strong>
            <ul>
              {leftOpen.rows.map((p, i) => (
                <li key={i}>{p.text}</li>
              ))}
            </ul>
          </div>
          <span className="notice-actions">
            <button className="btn" onClick={() => bringOver(leftOpen.rows)}>
              {LEFT_OPEN.add}
            </button>
            <button className="btn btn-ghost" onClick={() => dismissLeftOpen(leftOpen.dismiss)}>
              {LEFT_OPEN.dismiss}
            </button>
          </span>
        </div>
      )}
      {local.map((p) => {
        const empty = !hasText(p);
        // Every row with a task, and any row past Rows per day.
        const removable = p.uid != null || p.position > count;
        // A written row only: an empty one has nothing to file yet. Every row takes the grid with
        // the chip's column all the same, so on a wide screen a field ends in the same place
        // written or empty, and the first letter typed doesn't narrow it.
        const chip = pick != null && !empty;
        const placeholder = p.position === 1 ? 'The one thing to get done' : `Priority ${p.position}`;
        // While the box has the focus: retyped, a name that earlier days' lists hold renames it there
        // too; emptied, it says what happens to the name.
        const inFocus = focused != null && p.uid != null && focused.position === p.position;
        const blankName = inFocus && empty ? storedName(p.uid) : undefined;
        const note = blankName ? BLANK_NOTE(blankName) : inFocus && !empty && p.text !== focused.text && p.earlier > 0 ? RENAME_NOTE(p.earlier) : null;
        const noteFor = `${noteId}-note-${p.position}`;
        return (
          <Fragment key={p.position}>
            <div className={`priority-row${p.done ? ' is-done' : ''}${pick != null ? ' priority-row--end' : ''}`}>
              <span className="priority-num" aria-hidden="true">
                {p.position}
              </span>
              {/* The label is the tick's touch area (styles.css); the box itself is 22 px. */}
              <label className="priority-tick">
                <input
                  type="checkbox"
                  className="checkbox"
                  checked={p.done}
                  disabled={empty}
                  onChange={(e) => {
                    if (e.target.checked) {
                      // The sound plays once the tick has rendered; iOS only allows that after a tap unlocked it.
                      unlockAudio();
                      anchor.current = e.target;
                      setTicked({});
                    }
                    edit(p.position, { done: e.target.checked }, true);
                  }}
                  aria-label={`Priority ${p.position} done`}
                  title={empty ? 'Write the priority first' : undefined}
                />
              </label>
              {/* A textarea so a long priority wraps on a phone; the wrapper's copy of the text sets its height. */}
              <span className="grow-field" data-value={p.text || placeholder}>
                <textarea
                  ref={(el) => {
                    if (el) inputs.current.set(p.position, el);
                    else inputs.current.delete(p.position);
                  }}
                  className="input priority-input"
                  rows={1}
                  value={p.text}
                  placeholder={placeholder}
                  aria-label={`Priority ${p.position}`}
                  aria-describedby={note ? noteFor : undefined}
                  // One line of text: Enter adds no line break, and a pasted one becomes a space.
                  // Escape on a blank box brings the name back, as leaving it does.
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return;
                    if (e.key === 'Enter') e.preventDefault();
                    if (e.key === 'Escape' && isBlank(p)) restore(p);
                  }}
                  onChange={(e) => edit(p.position, { text: e.target.value.replace(/[\r\n]+/g, ' ') })}
                  onFocus={() => setFocused({ position: p.position, text: p.text })}
                  onBlur={() => {
                    setFocused(null);
                    if (isBlank(p)) restore(p);
                    else void flush();
                  }}
                  maxLength={LIMITS.priorityText}
                />
              </span>
              {chip && (
                <span className="priority-end">
                  {isRecurring(p) && <RepeatMark />}
                  {/* A pick saves at once, as a tick does. Keyed by the row, since the rows are by
                      position: a row another device's change moves here gets a chip of its own,
                      closed, so a list left open never picks for it. */}
                  <CategoryChip
                    key={p.uid}
                    value={p.categoryUid}
                    onChange={(categoryUid) => edit(p.position, { categoryUid }, true)}
                    pick={pick}
                    label={`Category for priority ${p.position}`}
                  />
                </span>
              )}
              {removable && (
                <button className="btn btn-icon priority-remove" onClick={() => remove(p)} aria-label={`Remove priority ${p.position}`} title="Remove">
                  <X />
                </button>
              )}
            </div>
            {note && (
              <p className="muted small priority-note" id={noteFor}>
                {note}
              </p>
            )}
          </Fragment>
        );
      })}
      {/* Always there, so the warning is heard when it arrives (see styles.css for its gap). */}
      <div className="priorities-notice" role="status">
        {warning && (
          <div className="notice notice--gentle">
            {warning.kind !== 'fresh' && (
              <div className="notice-done">
                <strong>
                  {done} of {total} done
                </strong>
                <ul>
                  {doneRows.map((p) => (
                    <li key={p.position}>
                      <Check />
                      <span>{p.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <span>{warning.text}</span>
            <span className="notice-actions">
              <button className="btn btn-ghost" onClick={() => addRow(true)}>
                {WARNING_ACTIONS[warning.kind].add}
              </button>
              <button className="btn btn-ghost" onClick={keepList}>
                {WARNING_ACTIONS[warning.kind].keep}
              </button>
            </span>
          </div>
        )}
      </div>
      {asked && (
        <RemoveTask
          name={asked.name}
          otherDays={asked.otherDays}
          logged={asked.logged > 0 ? formatDurationCeil(asked.logged) : null}
          onOffDay={() => answer(false)}
          onEverywhere={() => answer(true)}
          onCancel={() => setAsked(null)}
        />
      )}
      <Burst at={burst} />
      <div className="priorities-foot">
        {local.length < MAX_PRIORITIES ? (
          <button ref={addButton} className="btn btn-ghost priority-add" onClick={() => addRow()}>
            <Plus />
            Add priority
          </button>
        ) : (
          <span />
        )}
        {total > 0 && (
          <span className="priorities-summary muted">
            {done} of {total} done
          </span>
        )}
      </div>
    </div>
  );
}
