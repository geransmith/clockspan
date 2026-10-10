import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as api from '../api';
import { emptyDay } from '../../../shared/api.js';
import { mergePriorities } from '../../../shared/priorities.js';
import { mergePunches } from '../../../shared/punches.js';
import type { Day, Priority, PruneResult, Punch, Session } from '../types';
import { dismissByTag, warnQuietly, warnSaveFailed } from '../lib/alerts';
import { ApiError, goneAt } from '../lib/apiError';
import { ADD_PRIORITY_FAILED, LOAD_FAILED, SAVE_FAILED } from '../lib/copy';
import { endBreaksAt } from '../lib/breaks';
import { addPending, confirm, fetched, settle, shown, untracked, whileUnsettled, type Tracked } from '../lib/optimistic';
import { newTaskRow, padPriorities, placePriority } from '../lib/priorities';
import { editedSession } from '../lib/retro';
import { normalizePunches } from '../lib/timeclock';
import { useLatest } from './useLatest';
import { useRefreshLoop } from './useRefreshLoop';
import { useSettings } from './useSettings';
import { useTracked } from './useTracked';

/**
 * What the day store holds: a new object whenever a day, a failed first load or a prune
 * changes. Read with `useDays()`.
 */
interface DayState {
  days: Record<string, Day>;
  /** Dates whose first fetch failed; cleared by a load that succeeds. */
  failed: ReadonlySet<string>;
  /** Moves after a prune or a task the server changed everywhere (`taskChanged`): a range read before it may hold days, rows, names or links that are gone. */
  generation: number;
}

/**
 * Each day is kept as the server's copy plus the changes made here that the server hasn't
 * confirmed yet (`lib/optimistic.ts`), and the sheet shows the one laid over the other. So a
 * change shows at once, a failed save leaves the stored copy on screen (the banner says so), and
 * a day read from the server can never hide a change still on its way. Every setter but
 * `addPriority` and `editPriorities` (which answers a `PrioritiesEdit`) resolves to whether the
 * server saved it and never rejects, so `void store.x()` is a complete call site; a caller that
 * chains on a save reads the answer. `addPriority` resolves to the new row's uid and rejects when
 * it can't be saved. Saves reach the server in the order they were made: punches and priorities
 * go as whole lists with the list they were built on, which the server merges with what it holds,
 * so one PUT per list and day is out and only the newest waiting list follows it; the day's other
 * fields, each session, and the breaks queue their writes one after another. `pruneBefore` alone
 * goes out on no queue.
 * The object and its functions keep their identity for the provider's life, so effects and
 * callbacks may depend on it.
 */
interface DayStore {
  /**
   * Fetch a day. Never rejects: a failure on a day not loaded yet is recorded in `failed` and
   * raised as a banner; a loaded day keeps its copy and says nothing.
   */
  load: (date: string) => Promise<void>;
  /**
   * Fetch a day the store holds again, since another device may have changed it, or one whose
   * first load failed; a day it doesn't hold is left to its first load. Quiet: a failure keeps
   * the copy (or the error) shown without another banner. Resolves when the answer is in,
   * sharing a fetch already out.
   */
  refresh: (date: string) => Promise<void>;
  /**
   * `GET /days/range`, whose answer also lands on each day in it the store holds loaded when it
   * answers (as an empty day where the answer has none), unless that day holds a newer answer.
   * Rejects on a failure, without a banner.
   */
  readRange: (from: string, to: string) => Promise<Day[]>;
  /**
   * Settings → Data's delete: `POST /days/prune`, then every held day before `before` is read
   * again and `generation` moves. Rejects on a failure, unlike the setters.
   */
  pruneBefore: (before: string) => Promise<PruneResult>;
  /**
   * A task the server has changed on every day it is on (a priorities save or the board store's
   * `editItem` renamed it or gave it a category, `deleteItem` deleted it): every held day whose list
   * or log names it is read again, so its lists and sessions show the new name and category, or drop
   * it and show its time unplanned, and `generation` moves, so no range on screen shows it from an
   * older answer. `revision` is the write's: a read of those days already out answers below it.
   */
  taskChanged: (uid: string, revision: number) => void;
  /**
   * A day's punches, built on the rows the store shows now. The server keeps a punch another device
   * saved since (`mergePunches`), and until it answers the day shows the same merge.
   */
  setPunches: (date: string, punches: Punch[]) => Promise<boolean>;
  /**
   * A day's priorities, built on `base` (the list the caller read). The server lays the changes
   * made since `base` onto what it holds, so a row or a tick another device saved meanwhile
   * stays, and until it answers the day shows the same merge (`mergePriorities`). A row naming a
   * task the server doesn't hold makes it, and a row whose name or category differs from its base
   * row's renames or files its task on every day, and the held days naming it are read again
   * (`taskChanged`).
   */
  setPriorities: (date: string, priorities: Priority[], base: Priority[]) => Promise<boolean>;
  /**
   * A held day's priorities changed by `fn`, for a writer off the Priorities card (the board): `fn`
   * gets the rows the store shows now (`current()`, so a list a blur-flush just set), padded to the
   * user's count, and returns the list to save, or null for nothing to save. Saved as
   * `setPriorities` saves. Never rejects.
   */
  editPriorities: (date: string, fn: (rows: Priority[]) => Priority[] | null) => Promise<PrioritiesEdit>;
  /**
   * Add a priority from outside the card (the timer), a task typed new in `categoryUid` if given.
   * Resolves to its uid once saved; rejects if it could not be saved.
   */
  addPriority: (date: string, text: string, categoryUid?: string | null) => Promise<string>;
  /**
   * Resolves once no priorities save for that date is out or waiting, saved or not, and never
   * rejects. A write that names a priority's uid waits on it, because the server refuses a uid
   * it hasn't stored and the timer's and the sessions' queues aren't ordered after the list's.
   */
  prioritiesSaved: (date: string) => Promise<void>;
  setOvertimeApproved: (date: string, approved: boolean) => Promise<boolean>;
  /** The day's own work-day length in minutes; null goes back to the usual one. */
  setWorkMinutes: (date: string, minutes: number | null) => Promise<boolean>;
  setRetro: (date: string, patch: api.RetroPatch) => Promise<boolean>;
  /** A session the server has just confirmed at `revision` (the timer started, finished, paused or cancelled it). */
  applySession: (session: Session, revision: number) => void;
  removeSession: (date: string, id: number) => Promise<boolean>;
  updateSession: (date: string, id: number, patch: api.SessionEdit) => Promise<boolean>;
  /** Start a break now. Shown once the server has it, since the server may end another as it starts. */
  startBreak: (date: string, plannedSeconds: number) => Promise<boolean>;
  /** End a break early. */
  endBreak: (date: string, id: number) => Promise<boolean>;
  removeBreak: (date: string, id: number) => Promise<boolean>;
}

/**
 * How `editPriorities` ended: `'saved'`; `'notLoaded'`, the day isn't held, so there was no list
 * to change; `'skipped'`, the change gave nothing to save; `'failed'`, the save failed (the store
 * raised the banner and reads the day again). Only `'saved'` and `'failed'` sent anything.
 */
export type PrioritiesEdit = 'saved' | 'notLoaded' | 'skipped' | 'failed';

const StateCtx = createContext<DayState | null>(null);
const Ctx = createContext<DayStore | null>(null);

/** How a change reaches the confirmed copy once the server has answered for it. */
type Commit = (confirmed: Day) => Day;

/** A day from the server as the store keeps it: with the punch rows the card shows. */
function normalizeDay(d: Day): Day {
  return { ...d, punches: normalizePunches(d.punches) };
}

/** `list` with row `id` replaced by `row`, in start order, or dropped when `row` is null. */
function replaceById<T extends { id: number; startedAt: number }>(list: readonly T[], id: number, row: T | null): T[] {
  const others = list.filter((x) => x.id !== id);
  return row ? [...others, row].sort((a, b) => a.startedAt - b.startedAt) : others;
}

/** The day as the server now has it after confirming `session`: the row inserted, replaced or (cancelled) dropped. */
function withSession(d: Day, session: Session): Day {
  return { ...d, sessions: replaceById(d.sessions, session.id, session.status === 'cancelled' ? null : session) };
}

/** The lists a save sends whole. */
type ListField = 'punches' | 'priorities';

/** A list's save on its way (`sendLatest`): one per list and day. */
interface ListSave<T> {
  /** The newest list set: out now, or the next to go. */
  list: T;
  /** What the oldest list set and not sent yet was built on; it goes with `list`. */
  base: T;
  /** The pending change of each list set, sent or waiting. */
  ids: number[];
  /** How many of `ids` were set when the last PUT went out. */
  sent: number;
  /** Whether the newest list was saved, once none is out or waiting. */
  drained: Promise<boolean>;
}
type ListSaves = { [F in ListField]: Map<string, ListSave<Day[F]>> };

/** What the store keeps: each day it holds, and the dates whose first fetch failed. */
interface Held {
  days: Record<string, Tracked<Day>>;
  failed: ReadonlySet<string>;
}

// The shown day for each tracked value, worked out once per value: a day's object (and its
// lists) keeps its identity until that day changes, which the drafts that follow it rely on.
const shownDays = new WeakMap<Tracked<Day>, Day | undefined>();
function shownDay(t: Tracked<Day> | undefined): Day | undefined {
  if (!t) return undefined;
  if (!shownDays.has(t)) shownDays.set(t, shown(t));
  return shownDays.get(t);
}

export function DayProvider({ children }: { children: ReactNode }) {
  const { tracked, current, change, nextId, queue } = useTracked<Held>(() => ({ days: {}, failed: new Set() }));
  const { settings } = useSettings();
  const priorityCount = useLatest(settings.priorityCount);
  const inflight = useRef(new Map<string, Promise<void>>());
  // The date whose failed load raised the banner (one at a time: a newer one replaces it).
  const bannerFor = useRef<string | null>(null);
  // Each list's save on its way, by date.
  const listSaves = useRef<ListSaves>({ punches: new Map(), priorities: new Map() });
  const [generation, setGeneration] = useState(0);

  // The same state back when `fn` changes nothing (an answer the same as the stored copy), so a
  // read that changed nothing renders nothing.
  const update = useCallback(
    (date: string, fn: (t: Tracked<Day>) => Tracked<Day>) =>
      change((s) => {
        const t = s.days[date];
        const next = fn(t ?? untracked<Day>());
        return next === t ? s : { ...s, days: { ...s.days, [date]: next } };
      }),
    [change],
  );

  // `quiet`: a refresh, or asking again after a failed save or first load. A first load that
  // fails is recorded (the sheet and the next-day planner show it with Try again) and, unless
  // quiet, raised as a banner; a day already shown keeps its copy, and a failed save has
  // already said the server is down. An answer that isn't a day fails the same way. Never
  // rejects.
  const fetchDay = useCallback(
    function fetchDay(date: string, quiet = false): Promise<void> {
      const out = inflight.current.get(date);
      if (out) return out;
      const sentAt = (current().days[date] ?? untracked<Day>()).revision;
      let stale = false;
      const p = api
        .getDay(date)
        .then(({ value, revision }) => {
          const day = normalizeDay(value);
          update(date, (t) => {
            const answer = fetched(t, day, revision);
            // Below what the store knew as the read left, the server's count went back (a
            // restored backup), and asking again would loop.
            stale = answer.stale && revision >= sentAt;
            return answer.next;
          });
          change((s) => {
            if (!s.failed.has(date)) return s;
            const failed = new Set(s.failed);
            failed.delete(date);
            return { ...s, failed };
          });
          if (bannerFor.current === date) {
            bannerFor.current = null;
            dismissByTag('load-failed');
          }
        })
        .catch(() => {
          if (shownDay(current().days[date])) return;
          change((s) => (s.failed.has(date) ? s : { ...s, failed: new Set(s.failed).add(date) }));
          if (!quiet) {
            bannerFor.current = date;
            warnQuietly({ title: LOAD_FAILED.title, body: LOAD_FAILED.body, tag: 'load-failed' });
          }
        })
        .finally(() => {
          inflight.current.delete(date);
          // A change with a higher revision was laid on after this went out, so the answer was
          // dropped (or, on a day never loaded, taken as the best there is) and may miss another
          // device's change: ask again, whoever sent it. Only a change confirmed while a read is
          // out does this, so it stops when the writes do.
          if (stale) void fetchDay(date, true);
        });
      inflight.current.set(date, p);
      return p;
    },
    [current, change, update],
  );
  const load = useCallback((date: string) => fetchDay(date), [fetchDay]);

  const refresh = useCallback(
    async (date: string) => {
      const { days, failed } = current();
      // Not loaded yet: useDay's first fetch owns that. If it failed, asking again here brings
      // today's alarms back once the server answers, without anyone pressing Try again.
      if (!shownDay(days[date]) && !failed.has(date)) return;
      await fetchDay(date, true);
    },
    [current, fetchDay],
  );

  // A held day the server changed through another write at `revision` (one for another day, a
  // task's, a prune): the day's copy is raised to it, so a read already out, which answers below
  // it, is dropped and the day asked for again.
  const reread = useCallback(
    (date: string, revision: number) => {
      update(date, (t) => confirm(t, (d) => d, revision));
      void refresh(date);
    },
    [update, refresh],
  );

  // Reads again each held day `picks`.
  const readAgain = useCallback(
    (picks: (day: Day, date: string) => boolean, revision: number) => {
      for (const [date, t] of Object.entries(current().days)) {
        const day = shownDay(t);
        if (day && picks(day, date)) reread(date, revision);
      }
    },
    [current, reread],
  );

  const taskChanged = useCallback(
    (uid: string, revision: number) => {
      readAgain((day) => day.priorities.some((p) => p.uid === uid) || day.sessions.some((s) => s.priorityUid === uid), revision);
      setGeneration((g) => g + 1);
    },
    [readAgain],
  );

  // Every write ends here. Saved: the changes `ids` leave the pending list and the server's
  // answer becomes the stored copy. Not saved: they leave it all the same, so the screen is back
  // on the stored copy at once, a banner says so (the edit vanishing on its own would look like
  // the app losing data), and the day is asked for again in case the server moved on (another
  // device deleted the row being edited). That shares a load already out: a refusal names the
  // server's revision, which the day's copy is raised to, so a load that left before it comes
  // back stale and asks again itself. A failure with no answer (offline) raises nothing.
  const persist = useCallback(
    async (date: string, ids: readonly number[], run: () => Promise<api.Answer<Commit>>): Promise<boolean> => {
      try {
        const { value: commit, revision } = await run();
        update(date, (t) => confirm(settle(t, ids), commit, revision));
        return true;
      } catch (err) {
        update(date, (t) => confirm(settle(t, ids), (d) => d, err instanceof ApiError ? err.revision : 0));
        warnSaveFailed();
        void fetchDay(date, true);
        return false;
      }
    },
    [update, fetchDay],
  );

  // A PUT of a whole list (punches, priorities) could land after a newer one if two were in
  // flight. One goes out per list and day; the lists set meanwhile are skipped for the newest,
  // which goes out next. A failed save takes the waiting lists with it: they were built on the
  // one refused. `send` gets the list and its base and answers with the list as the server
  // stored it; `show` lays the list on the day's copy while it is on its way, as the server will
  // merge it. Resolves to whether the newest list was saved; `whenIdle` waits for it too.
  //
  // The newest list goes with the base of the oldest list not sent yet, so it carries every
  // change made since. That needs every list that takes a waiting one's place to be built on
  // `current()`, the copy that shows the one it replaces: the Priorities card flushes its draft
  // on blur, before any other control on the sheet acts, and `setPunches` and `editPriorities`
  // (which `addPriority` goes through) build on `current()`.
  const sendLatest = useCallback(
    <F extends ListField>(
      field: F,
      date: string,
      list: Day[F],
      send: (list: Day[F], base: Day[F]) => Promise<api.Answer<Day[F]>>,
      base: Day[F],
      show: (rows: Day[F]) => Day[F],
    ): Promise<boolean> => {
      const saves = listSaves.current[field];
      const id = nextId();
      update(date, (t) => addPending(t, id, (d) => ({ ...d, [field]: show(d[field]) })));
      const waiting = saves.get(date);
      if (waiting) {
        // None waits unsent behind the one out, so this list is the oldest not sent yet.
        if (waiting.sent === waiting.ids.length) waiting.base = base;
        waiting.list = list;
        waiting.ids.push(id);
        return waiting.drained;
      }
      const q = { list, base, ids: [id], sent: 0 };
      const drained = (async () => {
        try {
          // Each set adds its id: any past the ones sent means a newer list is waiting.
          while (q.sent < q.ids.length) {
            q.sent = q.ids.length;
            const { list: sending, base: builtOn } = q;
            const run = async (): Promise<api.Answer<Commit>> => {
              const { value: saved, revision } = await send(sending, builtOn);
              return { value: (d) => ({ ...d, [field]: saved }), revision };
            };
            if (!(await persist(date, [...q.ids], run))) {
              update(date, (t) => settle(t, q.ids));
              return false;
            }
          }
          return true;
        } finally {
          saves.delete(date);
        }
      })();
      saves.set(date, Object.assign(q, { drained }));
      return whileUnsettled(drained);
    },
    [nextId, update, persist],
  );

  // Writes that change part of a day (a field, a session, a break) each go out after the one
  // before them on the same key, so the server ends where the screen does. `apply` shows the
  // change at once; without one it shows when the server has it.
  const inOrder = useCallback(
    (key: string, date: string, apply: ((d: Day) => Day) | null, run: () => Promise<api.Answer<Commit>>): Promise<boolean> => {
      const id = nextId();
      if (apply) update(date, (t) => addPending(t, id, apply));
      return queue(() => persist(date, [id], run), key);
    },
    [nextId, update, persist, queue],
  );

  // A per-day field's PUT on the day's queue: shown at once, and the fields the server answers
  // with (as stored) laid on the stored copy.
  const putDayFields = useCallback(
    (date: string, apply: (d: Day) => Day, send: () => Promise<api.Answer<Partial<Day>>>) =>
      inOrder(`day:${date}`, date, apply, async () => {
        const { value: saved, revision } = await send();
        return { value: (d) => ({ ...d, ...saved }), revision };
      }),
    [inOrder],
  );

  const shownCopy = useCallback((date: string) => shownDay(current().days[date]), [current]);

  // Built on the rows shown now, as the card builds its list. A day not loaded has none, and an
  // empty base sends the list as it is.
  const setPunches = useCallback(
    (date: string, punches: Punch[]) => {
      const list = normalizePunches(punches);
      const base = shownCopy(date)?.punches ?? [];
      return sendLatest(
        'punches',
        date,
        list,
        async (p, b) => {
          const { value, revision } = await api.putPunches(date, p, b);
          return { value: normalizePunches(value.punches), revision };
        },
        base,
        (rows) => mergePunches(rows, base, list),
      );
    },
    [sendLatest, shownCopy],
  );

  // Every priorities save, the board's and the timer's included, shown as the server will merge
  // it while it is out. A task the save put on the list or took off (Plan tomorrow, a carry, ×) is
  // on another number of days (`listed`, `earlier`) wherever else it is, so the other held days
  // holding it are read again: × asks from those counts. A row whose name, category or note
  // differs from its base row's renamed, filed or noted its task on every day it is on
  // (`taskChanged`), which matters only when another day lists it or logged time on it (`listed`,
  // `logged`).
  const setPriorities = useCallback(
    (date: string, priorities: Priority[], base: Priority[]) =>
      sendLatest(
        'priorities',
        date,
        priorities,
        async (p, b) => {
          const {
            value: { priorities: saved },
            revision,
          } = await api.putPriorities(date, p, b);
          const moved = (uid: string | null) => uid != null && b.some((q) => q.uid === uid) !== saved.some((q) => q.uid === uid);
          readAgain((day, d) => d !== date && day.priorities.some((q) => moved(q.uid)), revision);
          const before = new Map(b.map((q) => [q.uid, q]));
          for (const q of p) {
            const was = q.uid == null ? undefined : before.get(q.uid);
            const elsewhere = was && (was.listed > 1 || was.logged > 0);
            if (elsewhere && (was.text.trim() !== q.text.trim() || was.categoryUid !== q.categoryUid || was.note !== q.note)) taskChanged(q.uid!, revision);
          }
          return { value: saved, revision };
        },
        base,
        (rows) => mergePriorities(rows, base, priorities),
      ),
    [sendLatest, readAgain, taskChanged],
  );

  const editPriorities = useCallback(
    async (date: string, fn: (rows: Priority[]) => Priority[] | null): Promise<PrioritiesEdit> => {
      const day = shownCopy(date);
      if (!day) return 'notLoaded';
      const next = fn(padPriorities(day.priorities, priorityCount.current));
      if (!next) return 'skipped';
      return (await setPriorities(date, next, day.priorities)) ? 'saved' : 'failed';
    },
    [shownCopy, setPriorities, priorityCount],
  );

  // Only onto a list the store holds: where the row goes depends on the rows already there.
  const addPriority = useCallback(
    async (date: string, text: string, categoryUid: string | null = null) => {
      const row = newTaskRow(text, categoryUid, Date.now());
      const edit = await editPriorities(date, (rows) => placePriority(rows, priorityCount.current, row));
      // A timer must not start against a uid the server never stored.
      if (edit !== 'saved')
        throw new Error(edit === 'notLoaded' ? ADD_PRIORITY_FAILED.notLoaded : edit === 'skipped' ? ADD_PRIORITY_FAILED.full : SAVE_FAILED.title);
      return row.uid;
    },
    [editPriorities, priorityCount],
  );

  const prioritiesSaved = useCallback(async (date: string) => {
    await listSaves.current.priorities.get(date)?.drained;
  }, []);

  const setRetro = useCallback(
    (date: string, patch: api.RetroPatch) => {
      const stamp = Date.now();
      return putDayFields(
        date,
        (d) => ({
          ...d,
          retroNote: patch.note ?? d.retroNote,
          retroAt: patch.done === undefined ? d.retroAt : patch.done ? (d.retroAt ?? stamp) : null,
        }),
        () => api.putRetro(date, patch),
      );
    },
    [putDayFields],
  );

  const setOvertimeApproved = useCallback(
    (date: string, approved: boolean) =>
      putDayFields(
        date,
        (d) => ({ ...d, overtimeApproved: approved }),
        () => api.putOvertime(date, approved),
      ),
    [putDayFields],
  );

  const setWorkMinutes = useCallback(
    (date: string, minutes: number | null) =>
      putDayFields(
        date,
        (d) => ({ ...d, workMinutes: minutes }),
        () => api.putTarget(date, minutes),
      ),
    [putDayFields],
  );

  // A session or a break starting at `at` ended the user's running break on the server whatever
  // its day (one started before midnight sits on the day before), so a loaded day still showing
  // one running past the start takes the same end.
  const endRunningBreaks = useCallback(
    (at: number, revision: number) => {
      for (const [date, t] of Object.entries(current().days)) {
        if (t.confirmed?.breaks.some((b) => b.endedAt > at)) update(date, (u) => confirm(u, (d) => ({ ...d, breaks: endBreaksAt(d.breaks, at) }), revision));
      }
    },
    [update, current],
  );

  // Confirmed already: straight into the stored copy. On a day not loaded yet, a load already
  // out predates it, so its answer is taken and the day asked for again (`fetchDay`).
  const applySession = useCallback(
    (session: Session, revision: number) => {
      update(session.date, (t) => confirm(t, (d) => withSession(d, session), revision));
      if (session.status === 'running') endRunningBreaks(session.startedAt, revision);
    },
    [update, endRunningBreaks],
  );

  const removeSession = useCallback(
    (date: string, id: number) => {
      const without = (d: Day) => ({ ...d, sessions: d.sessions.filter((s) => s.id !== id) });
      return inOrder(`session:${id}`, date, without, async () => {
        const { revision } = await goneAt(api.deleteSession(id));
        return { value: without, revision };
      });
    },
    [inOrder],
  );

  const updateSession = useCallback(
    (date: string, id: number, patch: api.SessionEdit) =>
      inOrder(
        `session:${id}`,
        date,
        (d) => ({ ...d, sessions: d.sessions.map((s) => (s.id === id ? editedSession(s, patch) : s)) }),
        async () => {
          if (patch.priorityUid) await prioritiesSaved(date);
          const {
            value: { session },
            revision,
          } = await api.patchSession(id, patch);
          return { value: (d) => withSession(d, session), revision };
        },
      ),
    [inOrder, prioritiesSaved],
  );

  // Break writes share one queue: an end or a delete never passes the start before it.
  const startBreak = useCallback(
    (date: string, plannedSeconds: number) =>
      inOrder('breaks', date, null, async () => {
        const {
          value: { break: saved },
          revision,
        } = await api.startBreak(date, plannedSeconds);
        // The server ended the one still running when this one started; the same here. By id: a
        // read may have brought this break in already, and a new break can take a deleted one's id.
        endRunningBreaks(saved.startedAt, revision);
        return { value: (d) => ({ ...d, breaks: replaceById(d.breaks, saved.id, saved) }), revision };
      }),
    [inOrder, endRunningBreaks],
  );

  // At once on screen: cut short now, or gone if it ran under a minute. The server's answer
  // then stands, a null one meaning it dropped the break or found it gone already. Only this
  // break: the server ends nothing once it is over, and a break another device started since,
  // which a read may bring in while the end is out, keeps running.
  const endBreak = useCallback(
    (date: string, id: number) => {
      const now = Date.now();
      return inOrder(
        'breaks',
        date,
        (d) => ({ ...d, breaks: d.breaks.flatMap((b) => (b.id === id ? endBreaksAt([b], now) : [b])) }),
        async () => {
          const { value, revision } = await goneAt(api.endBreak(id));
          const saved = value?.break ?? null;
          return { value: (d) => ({ ...d, breaks: replaceById(d.breaks, id, saved) }), revision };
        },
      );
    },
    [inOrder],
  );

  const removeBreak = useCallback(
    (date: string, id: number) => {
      const without = (d: Day) => ({ ...d, breaks: d.breaks.filter((b) => b.id !== id) });
      return inOrder('breaks', date, without, async () => {
        const { revision } = await goneAt(api.deleteBreak(id));
        return { value: without, revision };
      });
    },
    [inOrder],
  );

  const readRange = useCallback(
    async (from: string, to: string) => {
      const { value, revision } = await api.getRange(from, to);
      const days = value.days.map(normalizeDay);
      const byDate = new Map(days.map((d) => [d.date, d]));
      // Every day held loaded in the range now; one whose own answer is newer drops it. A day the
      // answer leaves out has no row on the server: `GET /days/:date` answers it as empty.
      for (const [date, t] of Object.entries(current().days)) {
        if (date >= from && date <= to && t.confirmed !== undefined)
          update(date, (u) => fetched(u, byDate.get(date) ?? normalizeDay(emptyDay(date)), revision).next);
      }
      return days;
    },
    [current, update],
  );

  // Sent at once, on no queue: each queue carries one day's, one session's or the breaks'
  // writes, and a prune spans every day before the cutoff, so there is no one queue for it to
  // wait behind. A change still on its way for a day before the cutoff can land after the prune
  // and re-create that day, which the read after it shows.
  const pruneBefore = useCallback(
    async (before: string) => {
      const { value: result, revision } = await api.pruneDays(before);
      for (const date of Object.keys(current().days)) if (date < before) reread(date, revision);
      setGeneration((g) => g + 1);
      return result;
    },
    [current, reread],
  );

  const days = useMemo(() => {
    const out: Record<string, Day> = {};
    for (const [date, t] of Object.entries(tracked.days)) {
      const day = shownDay(t);
      if (day) out[date] = day;
    }
    return out;
  }, [tracked.days]);

  const state = useMemo(() => ({ days, failed: tracked.failed, generation }), [days, tracked.failed, generation]);
  const store = useMemo(
    () => ({
      load,
      refresh,
      readRange,
      pruneBefore,
      taskChanged,
      setPunches,
      setPriorities,
      editPriorities,
      addPriority,
      prioritiesSaved,
      setOvertimeApproved,
      setWorkMinutes,
      setRetro,
      applySession,
      removeSession,
      updateSession,
      startBreak,
      endBreak,
      removeBreak,
    }),
    [
      load,
      refresh,
      readRange,
      pruneBefore,
      taskChanged,
      setPunches,
      setPriorities,
      editPriorities,
      addPriority,
      prioritiesSaved,
      setOvertimeApproved,
      setWorkMinutes,
      setRetro,
      applySession,
      removeSession,
      updateSession,
      startBreak,
      endBreak,
      removeBreak,
    ],
  );
  return (
    <StateCtx.Provider value={state}>
      <Ctx.Provider value={store}>{children}</Ctx.Provider>
    </StateCtx.Provider>
  );
}

export function useDayStore(): DayStore {
  const v = useContext(Ctx);
  if (!v) throw new Error('useDayStore outside DayProvider');
  return v;
}

export function useDays(): DayState {
  const v = useContext(StateCtx);
  if (!v) throw new Error('useDays outside DayProvider');
  return v;
}

/**
 * The day for a date key, loading it on first use. A day the store holds already is read again
 * each time a view shows it, since another device may have changed it, and one whose first load
 * failed is asked for again then, quietly. Otherwise a failed first load (`failed`) waits for the
 * caller's Try again (`store.load`) or, for today, `useRefreshDay`'s next tick.
 */
export function useDay(date: string): { day: Day | undefined; failed: boolean; store: DayStore } {
  const store = useDayStore();
  const { days, failed: failedDates } = useDays();
  const day = days[date];
  const failed = failedDates.has(date);
  useEffect(() => {
    if (!day && !failed) void store.load(date);
  }, [date, day, failed, store]);
  // Never keyed on `day`: each answer would send another read.
  useEffect(() => void store.refresh(date), [date, store]);
  return { day, failed, store };
}

/**
 * Keeps today in step with the server for the alarms (`useRefreshLoop`: every minute and when
 * the tab comes back), which also asks again for a day whose first load failed. True while a
 * come-back refresh is out.
 */
export function useRefreshDay(date: string): boolean {
  const { refresh } = useDayStore();
  return useRefreshLoop(() => refresh(date)).pending;
}
