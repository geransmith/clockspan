import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as api from '../api';
import type { Day, Priority, Punch, Session } from '../types';
import { dismissByTag, warnQuietly } from '../lib/alerts';
import { LOAD_FAILED, SAVE_FAILED } from '../lib/copy';
import { endBreaksAt } from '../lib/breaks';
import { addPending, confirm, fetched, settle, shown, untracked, type Tracked } from '../lib/optimistic';
import { newUid, placePriority } from '../lib/priorities';
import { normalizePunches } from '../lib/timeclock';
import { useLatest } from './useLatest';
import { useRefreshLoop } from './useRefreshLoop';
import { useSettings } from './useSettings';

/**
 * Each day is kept as the server's last copy plus the changes made here that the server hasn't
 * confirmed yet (`lib/optimistic.ts`), and the sheet shows the one laid over the other. So a
 * change shows at once, a failed save leaves the stored copy on screen (the banner says so), and
 * a day read from the server can never hide a change still on its way. The setters never reject:
 * `void store.x()` is a complete call site. `setPriorities` also says whether it saved, for the
 * callers that chain on it (`addPriority`, the next-day planner). Saves reach the server in the
 * order they were made: punches and priorities replace the whole list, so one PUT per day is
 * out and only the newest waiting list follows it; the day's other fields, each session, and the
 * breaks queue their writes one after another.
 */
interface DayStore {
  days: Record<string, Day>;
  /** Dates whose first fetch failed, with the message; cleared by a load that succeeds. */
  errors: Record<string, string>;
  /** Fetch a day. Never rejects: a failure is recorded in `errors` and raised as a banner. */
  load: (date: string) => Promise<void>;
  /**
   * Fetch a day already on screen again, since another device may have changed it, or one whose
   * first load failed. Quiet: a failure keeps the copy (or the error) shown without another
   * banner. Resolves when the answer is in, sharing a fetch already out.
   */
  refresh: (date: string) => Promise<void>;
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

/** The day as the server now has it after confirming `session`: the row inserted, replaced or (cancelled) dropped. */
function withSession(d: Day, session: Session): Day {
  const others = d.sessions.filter((s) => s.id !== session.id);
  const sessions = session.status === 'cancelled' ? others : [...others, session].sort((a, b) => a.startedAt - b.startedAt);
  // A session starting ended the running break on the server; the same here.
  const breaks = session.status === 'running' ? endBreaksAt(d.breaks, session.startedAt) : d.breaks;
  return { ...d, sessions, breaks };
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
  const [tracked, setTracked] = useState<Record<string, Tracked<Day>>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  // The same records the state holds, current at once: a callback that reads before it writes
  // (addPriority right after a priority blur-flush), and a fetch deciding whether its answer
  // lands, must see every change made so far, not the render it closed over.
  const store = useRef<Record<string, Tracked<Day>>>({});
  const latestErrors = useLatest(errors);
  const { settings } = useSettings();
  const priorityCount = useLatest(settings.priorityCount);
  const inflight = useRef(new Map<string, Promise<boolean>>());
  // The date whose failed load raised the banner (one at a time: a newer one replaces it).
  const bannerFor = useRef<string | null>(null);
  const listQueues = useRef(new Map<string, { latest: unknown; ids: number[]; drained: Promise<boolean> }>());
  const writeChains = useRef(new Map<string, Promise<boolean>>());
  const nextId = useRef(0);

  const update = useCallback((date: string, fn: (t: Tracked<Day>) => Tracked<Day>) => {
    store.current = { ...store.current, [date]: fn(store.current[date] ?? untracked<Day>()) };
    setTracked(store.current);
  }, []);

  // `quiet`: a refresh, or asking again after a failed save or first load. A first load that
  // fails is recorded (the sheet shows it with Try again) and, unless quiet, raised as a banner;
  // a day already shown keeps its copy, and a failed save has already said the server is down.
  // An answer that isn't a day fails the same way. Never rejects: it resolves to whether the
  // answer was stale, older than a change the server confirmed after it went out.
  const fetchDay = useCallback(
    function fetchDay(date: string, quiet = false): Promise<boolean> {
      const out = inflight.current.get(date);
      if (out) return out;
      const sentAt = (store.current[date] ?? untracked<Day>()).version;
      let again = false;
      const p = api
        .getDay(date)
        .then((d) => {
          const day = normalizeDay(d);
          let stale = false;
          update(date, (t) => {
            const answer = fetched(t, sentAt, day);
            stale = t.version !== sentAt;
            again = answer.again;
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
          return stale;
        })
        .catch((err: unknown) => {
          if (shownDay(store.current[date])) return false;
          setErrors((prev) => ({ ...prev, [date]: (err as Error).message }));
          if (!quiet) {
            bannerFor.current = date;
            warnQuietly({ title: LOAD_FAILED.title, body: LOAD_FAILED.body, tag: 'load-failed' });
          }
          return false;
        })
        .finally(() => {
          inflight.current.delete(date);
          // It landed on a day never loaded, but the server confirmed a change after it went out.
          if (again) void fetchDay(date, true);
        });
      inflight.current.set(date, p);
      return p;
    },
    [update],
  );
  const load = useCallback(
    async (date: string) => {
      await fetchDay(date);
    },
    [fetchDay],
  );

  const refresh = useCallback(
    async (date: string) => {
      // Not loaded yet: useDay's first fetch owns that. If it failed, asking again here brings
      // today's alarms back once the server answers, without anyone pressing Try again.
      if (!shownDay(store.current[date]) && !(date in latestErrors.current)) return;
      await fetchDay(date, true);
    },
    [latestErrors, fetchDay],
  );

  // Every write ends here. Saved: the changes `ids` leave the pending list and the server's
  // answer becomes the stored copy. Not saved: they leave it all the same, so the screen is back
  // on the stored copy at once, a banner says so (the edit vanishing on its own would look like
  // the app losing data), and the day is asked for again in case the server moved on (another
  // device deleted the row). That shares a load already out, whose answer is dropped if a
  // change was confirmed after it went out, so a stale answer asks once more.
  const persist = useCallback(
    async (date: string, ids: readonly number[], run: () => Promise<Commit>): Promise<boolean> => {
      try {
        const commit = await run();
        update(date, (t) => settle(t, ids, commit));
        return true;
      } catch {
        update(date, (t) => settle(t, ids));
        warnQuietly({ title: SAVE_FAILED.title, body: SAVE_FAILED.body, tag: 'save-failed' });
        void fetchDay(date, true).then((stale) => {
          if (stale) void fetchDay(date, true);
        });
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
      const id = ++nextId.current;
      update(date, (t) => addPending(t, id, apply));
      const waiting = listQueues.current.get(key);
      if (waiting) {
        waiting.latest = value;
        waiting.ids.push(id);
        return waiting.drained;
      }
      const q = { latest: value as unknown, ids: [id], drained: Promise.resolve(true) };
      listQueues.current.set(key, q);
      q.drained = (async () => {
        try {
          let sent: unknown = q; // nothing yet: `q` is never a list
          while (sent !== q.latest) {
            sent = q.latest;
            const batch = sent as T;
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
      return q.drained;
    },
    [update, persist],
  );

  // Writes that change part of a day (a field, a session, a break) each go out after the one
  // before them on the same key, so the server ends where the screen does. `apply` shows the
  // change at once; without one it shows when the server has it.
  const inOrder = useCallback(
    (key: string, date: string, apply: ((d: Day) => Day) | null, run: () => Promise<Commit>): Promise<boolean> => {
      const id = ++nextId.current;
      if (apply) update(date, (t) => addPending(t, id, apply));
      const next = (writeChains.current.get(key) ?? Promise.resolve(true)).then(() => persist(date, [id], run));
      writeChains.current.set(key, next);
      void next.finally(() => {
        if (writeChains.current.get(key) === next) writeChains.current.delete(key);
      });
      return next;
    },
    [update, persist],
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
      const day = shownDay(store.current[date]);
      // Only onto a list the store holds: one made up empty would replace the stored rows.
      if (!day) throw new Error(SAVE_FAILED.title);
      const uid = newUid();
      const next = placePriority(day.priorities, priorityCount.current, text, uid, Date.now());
      if (!next) throw new Error('The priorities list is full.');
      // A timer must not start against a uid the server never stored.
      if (!(await setPriorities(date, next))) throw new Error(SAVE_FAILED.title);
      return uid;
    },
    [setPriorities, priorityCount],
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
  // out predates it, so its answer is taken and the day asked for again (`fetched`).
  const applySession = useCallback((session: Session) => update(session.date, (t) => confirm(t, (d) => withSession(d, session))), [update]);

  const removeSession = useCallback(
    async (date: string, id: number) => {
      const without = (d: Day) => ({ ...d, sessions: d.sessions.filter((s) => s.id !== id) });
      await inOrder(`session:${id}`, date, without, async () => {
        await api.deleteSession(id);
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
  // then stands, a null one meaning it dropped the break.
  const endBreak = useCallback(
    async (date: string, id: number) => {
      const now = Date.now();
      await inOrder(
        'breaks',
        date,
        (d) => ({ ...d, breaks: d.breaks.flatMap((b) => (b.id === id ? endBreaksAt([b], now) : [b])) }),
        async () => {
          const { break: saved } = await api.endBreak(id);
          return (d) => {
            const others = d.breaks.filter((b) => b.id !== id);
            return { ...d, breaks: saved ? [...others, saved].sort((a, b) => a.startedAt - b.startedAt) : others };
          };
        },
      );
    },
    [inOrder],
  );

  const removeBreak = useCallback(
    async (date: string, id: number) => {
      const without = (d: Day) => ({ ...d, breaks: d.breaks.filter((b) => b.id !== id) });
      await inOrder('breaks', date, without, async () => {
        await api.deleteBreak(id);
        return without;
      });
    },
    [inOrder],
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
 * The day for a date key, loading it on first use. A failed load waits for `store.load` again
 * (the sheet's Try again) or, for a day kept in step by `useRefreshDay`, its next tick.
 */
export function useDay(date: string): { day: Day | undefined; store: DayStore } {
  const store = useDayStore();
  const day = store.days[date];
  const failed = date in store.errors;
  useEffect(() => {
    if (!day && !failed) void store.load(date);
  }, [date, day, failed, store]);
  return { day, store };
}

/**
 * Keeps a day that is on screen in step with the server (`useRefreshLoop`: every minute and
 * when the tab comes back), which also asks again for a day whose first load failed. True
 * while a come-back refresh is out.
 */
export function useRefreshDay(date: string): boolean {
  const { refresh } = useDayStore();
  return useRefreshLoop(() => refresh(date));
}
