import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as api from '../api';
import { emptyDay } from '../../../shared/api.js';
import type { Day, Priority, PruneResult, Punch, Session } from '../types';
import { dismissByTag, warnQuietly } from '../lib/alerts';
import { ApiError } from '../lib/apiError';
import { ADD_PRIORITY_FAILED, LOAD_FAILED, SAVE_FAILED } from '../lib/copy';
import { endBreaksAt } from '../lib/breaks';
import { addPending, confirm, fetched, settle, shown, untracked, type Tracked } from '../lib/optimistic';
import { newUid, placePriority } from '../lib/priorities';
import { normalizePunches } from '../lib/timeclock';
import { useLatest } from './useLatest';
import { useRefreshLoop } from './useRefreshLoop';
import { useSettings } from './useSettings';
import { useTracked } from './useTracked';

/**
 * Each day is kept as the server's copy plus the changes made here that the server hasn't
 * confirmed yet (`lib/optimistic.ts`), and the sheet shows the one laid over the other. So a
 * change shows at once, a failed save leaves the stored copy on screen (the banner says so), and
 * a day read from the server can never hide a change still on its way. The setters never reject:
 * `void store.x()` is a complete call site. `setPriorities` also says whether it saved, for the
 * callers that chain on it (`addPriority`, the next-day planner). Saves reach the server in the
 * order they were made: punches and priorities replace the whole list, so one PUT per list and
 * day is out and only the newest waiting list follows it; the day's other fields, each session,
 * and the breaks queue their writes one after another. `pruneBefore` alone goes out on no queue.
 */
interface DayStore {
  days: Record<string, Day>;
  /** Dates whose first fetch failed, with the message; cleared by a load that succeeds. */
  errors: Record<string, string>;
  /**
   * Fetch a day. Never rejects: a failure on a day not loaded yet is recorded in `errors` and
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
   * `GET /days/range`, whose answer also lands on each day in it the store held when it went
   * out (as an empty day where the answer has none), unless the server confirmed a change to
   * that day meanwhile. Rejects on a failure, without a banner.
   */
  readRange: (from: string, to: string) => Promise<Day[]>;
  /**
   * Settings → Data's delete: `POST /days/prune`, then every held day before `before` is read
   * again and `generation` moves. Rejects on a failure, unlike the setters.
   */
  pruneBefore: (before: string) => Promise<PruneResult>;
  /** Moves after a prune: a range read before it may hold days that are gone. */
  generation: number;
  setPunches: (date: string, punches: Punch[]) => Promise<void>;
  setPriorities: (date: string, priorities: Priority[]) => Promise<boolean>;
  /** Add a priority from outside the card (the timer). Resolves to its uid; rejects if it could not be saved. */
  addPriority: (date: string, text: string) => Promise<string>;
  setOvertimeApproved: (date: string, approved: boolean) => Promise<void>;
  /** The day's own work-day length in minutes; null goes back to the usual one. */
  setWorkMinutes: (date: string, minutes: number | null) => Promise<void>;
  setRetro: (date: string, patch: { note?: string; done?: boolean }) => Promise<void>;
  /** A session the server has just confirmed (the timer started, finished, paused or cancelled it). */
  applySession: (session: Session) => void;
  removeSession: (date: string, id: number) => Promise<void>;
  updateSession: (date: string, id: number, patch: { label?: string; priorityUid?: string | null }) => Promise<void>;
  /** Start a break now. Shown once the server has it, since the server may end another as it starts. */
  startBreak: (date: string, plannedSeconds: number) => Promise<void>;
  /** End a break early. */
  endBreak: (date: string, id: number) => Promise<void>;
  removeBreak: (date: string, id: number) => Promise<void>;
}

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
  const sessions = replaceById(d.sessions, session.id, session.status === 'cancelled' ? null : session);
  // A session starting ended the running break on the server; the same here.
  const breaks = session.status === 'running' ? endBreaksAt(d.breaks, session.startedAt) : d.breaks;
  return { ...d, sessions, breaks };
}

/**
 * A delete or a break's end answered 404 found the row gone already (another device deleted
 * it): what was asked, so it counts as done, with null for the answer.
 */
async function unlessGone<T>(send: Promise<T>): Promise<T | null> {
  try {
    return await send;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
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
  const { tracked, current, change, nextId, queue } = useTracked<Record<string, Tracked<Day>>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const latestErrors = useLatest(errors);
  const { settings } = useSettings();
  const priorityCount = useLatest(settings.priorityCount);
  const inflight = useRef(new Map<string, Promise<void>>());
  // The date whose failed load raised the banner (one at a time: a newer one replaces it).
  const bannerFor = useRef<string | null>(null);
  const listQueues = useRef(new Map<string, { latest: unknown; ids: number[]; drained: Promise<boolean> }>());
  const [generation, setGeneration] = useState(0);

  const update = useCallback(
    (date: string, fn: (t: Tracked<Day>) => Tracked<Day>) => change((all) => ({ ...all, [date]: fn(all[date] ?? untracked<Day>()) })),
    [change],
  );

  // `quiet`: a refresh, or asking again after a failed save or first load. A first load that
  // fails is recorded (the sheet shows it with Try again) and, unless quiet, raised as a banner;
  // a day already shown keeps its copy, and a failed save has already said the server is down.
  // An answer that isn't a day fails the same way. Never rejects.
  const fetchDay = useCallback(
    function fetchDay(date: string, quiet = false): Promise<void> {
      const out = inflight.current.get(date);
      if (out) return out;
      const sentAt = (current()[date] ?? untracked<Day>()).version;
      let stale = false;
      const p = api
        .getDay(date)
        .then((d) => {
          const day = normalizeDay(d);
          update(date, (t) => {
            const answer = fetched(t, sentAt, day);
            stale = answer.stale;
            return answer.next;
          });
          setErrors((prev) => {
            if (!(date in prev)) return prev;
            const next = { ...prev };
            delete next[date];
            return next;
          });
          if (bannerFor.current === date) {
            bannerFor.current = null;
            dismissByTag('load-failed');
          }
        })
        .catch((err: unknown) => {
          if (shownDay(current()[date])) return;
          setErrors((prev) => ({ ...prev, [date]: (err as Error).message }));
          if (!quiet) {
            bannerFor.current = date;
            warnQuietly({ title: LOAD_FAILED.title, body: LOAD_FAILED.body, tag: 'load-failed' });
          }
        })
        .finally(() => {
          inflight.current.delete(date);
          // The server confirmed a change after this went out, so the answer was dropped (or, on
          // a day never loaded, taken as the best there is) and may miss another device's
          // change: ask again, whoever sent it. Only a change confirmed while a read is out does
          // this, so it stops when the writes do.
          if (stale) void fetchDay(date, true);
        });
      inflight.current.set(date, p);
      return p;
    },
    [current, update],
  );
  const load = useCallback((date: string) => fetchDay(date), [fetchDay]);

  const refresh = useCallback(
    async (date: string) => {
      // Not loaded yet: useDay's first fetch owns that. If it failed, asking again here brings
      // today's alarms back once the server answers, without anyone pressing Try again.
      if (!shownDay(current()[date]) && !(date in latestErrors.current)) return;
      await fetchDay(date, true);
    },
    [current, latestErrors, fetchDay],
  );

  // Every write ends here. Saved: the changes `ids` leave the pending list and the server's
  // answer becomes the stored copy. Not saved: they leave it all the same, so the screen is back
  // on the stored copy at once, a banner says so (the edit vanishing on its own would look like
  // the app losing data), and the day is asked for again in case the server moved on (another
  // device deleted the row being edited). That shares a load already out, and a load whose
  // answer comes back stale asks again itself.
  const persist = useCallback(
    async (date: string, ids: readonly number[], run: () => Promise<Commit>): Promise<boolean> => {
      try {
        const commit = await run();
        update(date, (t) => settle(t, ids, commit));
        return true;
      } catch {
        update(date, (t) => settle(t, ids));
        warnQuietly({ title: SAVE_FAILED.title, body: SAVE_FAILED.body, tag: 'save-failed' });
        void fetchDay(date, true);
        return false;
      }
    },
    [update, fetchDay],
  );

  // A PUT that replaces a whole list (punches, priorities) could land after a newer one if two
  // were in flight. One goes out per key; the lists set meanwhile are skipped for the newest,
  // which goes out next. A failed save takes the waiting lists with it: they were built on the
  // one refused. Resolves to whether the newest list was saved.
  const sendLatest = useCallback(
    <T,>(key: string, date: string, value: T, apply: (d: Day) => Day, send: (value: T) => Promise<Commit>): Promise<boolean> => {
      const id = nextId();
      update(date, (t) => addPending(t, id, apply));
      const waiting = listQueues.current.get(key);
      if (waiting) {
        waiting.latest = value;
        waiting.ids.push(id);
        return waiting.drained;
      }
      const q = { latest: value as unknown, ids: [id] };
      const drained = (async () => {
        try {
          // Each set adds its id: any past the ones sent means a newer list is waiting.
          let sent = 0;
          while (sent < q.ids.length) {
            sent = q.ids.length;
            const batch = q.latest as T;
            if (!(await persist(date, [...q.ids], () => send(batch)))) {
              update(date, (t) => settle(t, q.ids));
              return false;
            }
          }
          return true;
        } finally {
          listQueues.current.delete(key);
        }
      })();
      listQueues.current.set(key, Object.assign(q, { drained }));
      return drained;
    },
    [nextId, update, persist],
  );

  // Writes that change part of a day (a field, a session, a break) each go out after the one
  // before them on the same key, so the server ends where the screen does. `apply` shows the
  // change at once; without one it shows when the server has it.
  const inOrder = useCallback(
    (key: string, date: string, apply: ((d: Day) => Day) | null, run: () => Promise<Commit>): Promise<boolean> => {
      const id = nextId();
      if (apply) update(date, (t) => addPending(t, id, apply));
      return queue(() => persist(date, [id], run), key);
    },
    [nextId, update, persist, queue],
  );

  const setPunches = useCallback(
    async (date: string, punches: Punch[]) => {
      const normalized = normalizePunches(punches);
      await sendLatest(
        `punches:${date}`,
        date,
        normalized,
        (d) => ({ ...d, punches: normalized }),
        async (p) => {
          const { punches: saved } = await api.putPunches(date, p);
          return (d) => ({ ...d, punches: normalizePunches(saved) });
        },
      );
    },
    [sendLatest],
  );

  const setPriorities = useCallback(
    (date: string, priorities: Priority[]) =>
      sendLatest(
        `priorities:${date}`,
        date,
        priorities,
        (d) => ({ ...d, priorities }),
        async (p) => {
          const { priorities: saved } = await api.putPriorities(date, p);
          return (d) => ({ ...d, priorities: saved });
        },
      ),
    [sendLatest],
  );

  const addPriority = useCallback(
    async (date: string, text: string) => {
      const day = shownDay(current()[date]);
      // Only onto a list the store holds: one made up empty would replace the stored rows.
      if (!day) throw new Error(ADD_PRIORITY_FAILED.notLoaded);
      const uid = newUid();
      const next = placePriority(day.priorities, priorityCount.current, text, uid, Date.now());
      if (!next) throw new Error(ADD_PRIORITY_FAILED.full);
      // A timer must not start against a uid the server never stored.
      if (!(await setPriorities(date, next))) throw new Error(SAVE_FAILED.title);
      return uid;
    },
    [current, setPriorities, priorityCount],
  );

  const setRetro = useCallback(
    async (date: string, patch: { note?: string; done?: boolean }) => {
      const stamp = Date.now();
      await inOrder(
        `day:${date}`,
        date,
        (d) => ({
          ...d,
          retroNote: patch.note ?? d.retroNote,
          retroAt: patch.done === undefined ? d.retroAt : patch.done ? (d.retroAt ?? stamp) : null,
        }),
        async () => {
          const saved = await api.putRetro(date, patch);
          return (d) => ({ ...d, retroNote: saved.retroNote, retroAt: saved.retroAt });
        },
      );
    },
    [inOrder],
  );

  const setOvertimeApproved = useCallback(
    async (date: string, approved: boolean) => {
      await inOrder(
        `day:${date}`,
        date,
        (d) => ({ ...d, overtimeApproved: approved }),
        async () => {
          const saved = await api.putOvertime(date, approved);
          return (d) => ({ ...d, overtimeApproved: saved.overtimeApproved });
        },
      );
    },
    [inOrder],
  );

  const setWorkMinutes = useCallback(
    async (date: string, minutes: number | null) => {
      await inOrder(
        `day:${date}`,
        date,
        (d) => ({ ...d, workMinutes: minutes }),
        async () => {
          const saved = await api.putTarget(date, minutes);
          return (d) => ({ ...d, workMinutes: saved.workMinutes });
        },
      );
    },
    [inOrder],
  );

  // Confirmed already: straight into the stored copy. On a day not loaded yet, a load already
  // out predates it, so its answer is taken and the day asked for again (`fetchDay`). A session
  // starting ended the user's running break on the server whatever its day (one started before
  // midnight sits on the day before), so a loaded day still showing one running past the start
  // takes the same end; the session's own day no longer does after `withSession`.
  const applySession = useCallback(
    (session: Session) => {
      update(session.date, (t) => confirm(t, (d) => withSession(d, session)));
      if (session.status !== 'running') return;
      for (const [date, t] of Object.entries(current())) {
        if (t.confirmed?.breaks.some((b) => b.endedAt > session.startedAt)) {
          update(date, (u) => confirm(u, (d) => ({ ...d, breaks: endBreaksAt(d.breaks, session.startedAt) })));
        }
      }
    },
    [update, current],
  );

  const removeSession = useCallback(
    async (date: string, id: number) => {
      const without = (d: Day) => ({ ...d, sessions: d.sessions.filter((s) => s.id !== id) });
      await inOrder(`session:${id}`, date, without, async () => {
        await unlessGone(api.deleteSession(id));
        return without;
      });
    },
    [inOrder],
  );

  const updateSession = useCallback(
    async (date: string, id: number, patch: { label?: string; priorityUid?: string | null }) => {
      await inOrder(
        `session:${id}`,
        date,
        (d) => ({ ...d, sessions: d.sessions.map((s) => (s.id === id ? { ...s, ...patch } : s)) }),
        async () => {
          const { session } = await api.patchSession(id, patch);
          return (d) => withSession(d, session);
        },
      );
    },
    [inOrder],
  );

  // Break writes share one queue: an end or a delete never passes the start before it.
  const startBreak = useCallback(
    async (date: string, plannedSeconds: number) => {
      await inOrder('breaks', date, null, async () => {
        const { break: saved } = await api.startBreak(date, plannedSeconds);
        // The server ended the one still running when this one started; the same here.
        return (d) => ({ ...d, breaks: [...endBreaksAt(d.breaks, saved.startedAt), saved] });
      });
    },
    [inOrder],
  );

  // At once on screen: cut short now, or gone if it ran under a minute. The server's answer
  // then stands, a null one meaning it dropped the break or found it gone already.
  const endBreak = useCallback(
    async (date: string, id: number) => {
      const now = Date.now();
      await inOrder(
        'breaks',
        date,
        (d) => ({ ...d, breaks: d.breaks.flatMap((b) => (b.id === id ? endBreaksAt([b], now) : [b])) }),
        async () => {
          const saved = (await unlessGone(api.endBreak(id)))?.break ?? null;
          return (d) => ({ ...d, breaks: replaceById(d.breaks, id, saved) });
        },
      );
    },
    [inOrder],
  );

  const removeBreak = useCallback(
    async (date: string, id: number) => {
      const without = (d: Day) => ({ ...d, breaks: d.breaks.filter((b) => b.id !== id) });
      await inOrder('breaks', date, without, async () => {
        await unlessGone(api.deleteBreak(id));
        return without;
      });
    },
    [inOrder],
  );

  const readRange = useCallback(
    async (from: string, to: string) => {
      // Only the days held when it went out: one loaded since has a newer answer of its own.
      const sent = Object.entries(current())
        .filter(([date, t]) => date >= from && date <= to && t.confirmed !== undefined)
        .map(([date, t]) => [date, t.version] as const);
      const { days } = await api.getRange(from, to);
      const byDate = new Map(days.map((d) => [d.date, d]));
      change((all) => {
        const next = { ...all };
        // A day the answer leaves out has no row on the server: `GET /days/:date` answers it as empty.
        for (const [date, sentAt] of sent) next[date] = fetched(all[date]!, sentAt, normalizeDay(byDate.get(date) ?? emptyDay(date))).next;
        return next;
      });
      return days;
    },
    [current, change],
  );

  // Sent at once, on no queue: each queue carries one day's, one session's or the breaks'
  // writes, and a prune spans every day before the cutoff, so there is no one queue for it to
  // wait behind. A change still on its way for a day before the cutoff can land after the prune
  // and re-create that day, which the read after it shows.
  const pruneBefore = useCallback(
    async (before: string) => {
      const result = await api.pruneDays(before);
      for (const date of Object.keys(current())) {
        if (date >= before) continue;
        // Counted as a change the server confirmed: a read already out predates the prune, so
        // its answer is dropped (or, on a day never loaded, taken) and the day asked for again.
        update(date, (t) => confirm(t, (d) => d));
        void refresh(date);
      }
      setGeneration((g) => g + 1);
      return result;
    },
    [current, update, refresh],
  );

  const days = useMemo(() => {
    const out: Record<string, Day> = {};
    for (const [date, t] of Object.entries(tracked)) {
      const day = shownDay(t);
      if (day) out[date] = day;
    }
    return out;
  }, [tracked]);

  const value = useMemo(
    () => ({
      days,
      errors,
      load,
      refresh,
      readRange,
      pruneBefore,
      generation,
      setPunches,
      setPriorities,
      addPriority,
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
      days,
      errors,
      load,
      refresh,
      readRange,
      pruneBefore,
      generation,
      setPunches,
      setPriorities,
      addPriority,
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
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDayStore(): DayStore {
  const v = useContext(Ctx);
  if (!v) throw new Error('useDayStore outside DayProvider');
  return v;
}

/**
 * The day for a date key, loading it on first use. A day the store holds already is read again
 * each time a view shows it, since another device may have changed it, and one whose first load
 * failed is asked for again then, quietly. Otherwise a failed load waits for `store.load` (the
 * sheet's Try again) or, for today, `useRefreshDay`'s next tick.
 */
export function useDay(date: string): { day: Day | undefined; store: DayStore } {
  const store = useDayStore();
  // `load` and `refresh` keep their identity; the store is a new object whenever any day changes.
  const { load, refresh } = store;
  const day = store.days[date];
  const failed = date in store.errors;
  useEffect(() => {
    if (!day && !failed) void load(date);
  }, [date, day, failed, load]);
  // Never keyed on `day`: each answer would send another read.
  useEffect(() => void refresh(date), [date, refresh]);
  return { day, store };
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
