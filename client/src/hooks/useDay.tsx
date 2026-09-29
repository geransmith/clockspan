import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as api from '../api';
import { emptyDay } from '../../../shared/api.js';
import { MINUTE_MS } from '../../../shared/dates.js';
import type { Day, Priority, Punch, Session } from '../types';
import { dismissByTag, warnQuietly } from '../lib/alerts';
import { LOAD_FAILED, SAVE_FAILED } from '../lib/copy';
import { endBreaksAt } from '../lib/breaks';
import { newUid, placePriority } from '../lib/priorities';
import { emptyPunches, normalizePunches } from '../lib/timeclock';
import { useLatest } from './useLatest';
import { useSettings } from './useSettings';

/**
 * The setters are optimistic and never reject: a failed save puts the server's copy back and
 * raises a banner, so a `void store.x()` call site is complete. `setPriorities` also says
 * whether it saved, for the callers that chain on it (`addPriority`, the next-day planner).
 * Saves reach the server in the order they were made: punches and priorities replace the whole
 * list, so one PUT per day is in flight and only the newest waiting list follows it; the other
 * fields of a day, and each session, queue their writes one after another.
 */
interface DayStore {
  days: Record<string, Day>;
  /** Dates whose first fetch failed, with the message; cleared by a load that succeeds. */
  errors: Record<string, string>;
  /** Fetch a day. Never rejects: a failure is recorded in `errors` and raised as a banner. */
  load: (date: string) => Promise<void>;
  /**
   * Re-fetch a day already on screen, since another device may have changed it, or one whose
   * first load failed. Quiet: a failure keeps the copy (or the error) shown without another
   * banner, and nothing is sent while a save is out. Resolves when done.
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
  /** Insert or replace a session in its day (used by the timer when one completes). */
  applySession: (session: Session) => void;
  removeSession: (date: string, id: number) => Promise<void>;
  updateSession: (id: number, patch: { label?: string; notes?: string; priorityUid?: string | null }) => Promise<void>;
  /** Start a break now. Not optimistic: it shows once the server has it, since the server may end another. */
  startBreak: (date: string, plannedSeconds: number) => Promise<void>;
  /** End a break early. */
  endBreak: (date: string, id: number) => Promise<void>;
  removeBreak: (date: string, id: number) => Promise<void>;
}

const Ctx = createContext<DayStore | null>(null);

/** A day from the server as the store keeps it: with the punch rows the card shows. */
function normalizeDay(d: Day): Day {
  return { ...d, punches: normalizePunches(d.punches) };
}

function withDay(days: Record<string, Day>, date: string, fn: (d: Day) => Day): Record<string, Day> {
  const current = days[date] ?? { ...emptyDay(date), punches: emptyPunches() };
  return { ...days, [date]: fn(current) };
}

export function DayProvider({ children }: { children: ReactNode }) {
  const [days, setDays] = useState<Record<string, Day>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  // For callbacks that read before they write (addPriority): a click right after a priority
  // blur-flush must see the flushed list, not the render it closed over.
  const latest = useLatest(days);
  const latestErrors = useLatest(errors);
  const { settings } = useSettings();
  const priorityCount = useLatest(settings.priorityCount);
  const inflight = useRef(new Map<string, Promise<void>>());
  const listQueues = useRef(new Map<string, { latest: unknown; drained: Promise<boolean> }>());
  const writeChains = useRef(new Map<string, Promise<boolean>>());
  // A refresh sent before a write and answered after it would put the older copy back, so
  // every write bumps this and a refresh answer is dropped when it has moved (the timer's
  // `mutationSeq`). `saving` counts writes in flight so no refresh is sent during one.
  const mutationSeq = useRef(0);
  const saving = useRef(0);

  // `quiet` is the minute tick asking again after a failed first load: the error is already on
  // the sheet, so another failure changes nothing on screen. `reload` is a failed save putting
  // the stored day back: it asks afresh rather than wait on a GET already out, and its answer
  // lands whatever was written since.
  const fetchDay = useCallback(
    (date: string, { quiet = false, reload = false } = {}) => {
      const existing = inflight.current.get(date);
      if (existing && !reload) return existing;
      // Otherwise a write made after this GET went out is newer than its answer (the timer's
      // cross-device sync can ask for a day while a punch is on its way), so the answer only
      // lands on a day with nothing written since.
      const seq = mutationSeq.current;
      const p: Promise<void> = api
        .getDay(date)
        .then((d) => {
          if (reload || mutationSeq.current === seq || !latest.current[date]) {
            setDays((prev) => ({ ...prev, [date]: normalizeDay(d) }));
          }
          setErrors((prev) => {
            if (!(date in prev)) return prev;
            const next = { ...prev };
            delete next[date];
            return next;
          });
          dismissByTag('load-failed');
        })
        .catch((err: unknown) => {
          // A refresh after a failed save has a copy to keep showing, and that save's banner
          // already said the server is not answering. A first load has nothing: say so.
          if (latest.current[date]) return;
          setErrors((prev) => ({ ...prev, [date]: (err as Error).message }));
          if (!quiet) warnQuietly({ title: LOAD_FAILED.title, body: LOAD_FAILED.body, tag: 'load-failed' });
        })
        .finally(() => {
          if (inflight.current.get(date) === p) inflight.current.delete(date);
        });
      inflight.current.set(date, p);
      return p;
    },
    [latest],
  );
  const load = useCallback((date: string) => fetchDay(date), [fetchDay]);

  // Every write ends here: on failure the server's copy replaces an optimistic guess (`date`
  // null when there was none) and a banner says so, since the edit vanishing on its own would
  // look like the app losing data.
  const persist = useCallback(
    async (date: string | null, run: () => Promise<unknown>): Promise<boolean> => {
      mutationSeq.current++;
      saving.current++;
      try {
        await run();
        return true;
      } catch {
        if (date) void fetchDay(date, { reload: true });
        warnQuietly({ title: SAVE_FAILED.title, body: SAVE_FAILED.body, tag: 'save-failed' });
        return false;
      } finally {
        saving.current--;
      }
    },
    [fetchDay],
  );

  // A PUT that replaces a whole list (punches, priorities) could land after a newer one if two
  // were in flight. One goes out per key; the lists set meanwhile are skipped for the newest,
  // which goes out next. A failed save drops the rest: `persist` has reloaded the day by then.
  // Resolves to whether the newest list was saved.
  const sendLatest = useCallback(
    <T,>(key: string, date: string, value: T, send: (value: T) => Promise<unknown>): Promise<boolean> => {
      const waiting = listQueues.current.get(key);
      if (waiting) {
        waiting.latest = value;
        return waiting.drained;
      }
      const q = { latest: value as unknown, drained: Promise.resolve(true) };
      listQueues.current.set(key, q);
      q.drained = (async () => {
        try {
          let sent: unknown = q; // nothing yet: `q` is never a list
          while (sent !== q.latest) {
            sent = q.latest;
            const batch = sent as T;
            if (!(await persist(date, () => send(batch)))) return false;
          }
          return true;
        } finally {
          listQueues.current.delete(key);
        }
      })();
      return q.drained;
    },
    [persist],
  );

  // Writes that change part of a row (overtime, the work day, the retro, a session) each go
  // out after the one before them on the same key, so the server ends where the screen does.
  const inOrder = useCallback(
    (key: string, date: string | null, run: () => Promise<unknown>): Promise<boolean> => {
      // Out from the moment it is queued: a refresh must not land between the change on
      // screen and its PUT.
      mutationSeq.current++;
      saving.current++;
      const next = (writeChains.current.get(key) ?? Promise.resolve(true)).then(() => persist(date, run)).finally(() => saving.current--);
      writeChains.current.set(key, next);
      void next.finally(() => {
        if (writeChains.current.get(key) === next) writeChains.current.delete(key);
      });
      return next;
    },
    [persist],
  );

  const refresh = useCallback(
    (date: string) => {
      if (inflight.current.has(date) || saving.current > 0) return Promise.resolve();
      // Not loaded yet: useDay's first fetch owns that. If it failed, asking again here brings
      // today's alarms back once the server answers, without anyone pressing Try again.
      if (!latest.current[date]) return date in latestErrors.current ? fetchDay(date, { quiet: true }) : Promise.resolve();
      const seq = mutationSeq.current;
      return api
        .getDay(date)
        .then((d) => {
          if (mutationSeq.current !== seq) return;
          setDays((prev) => ({ ...prev, [date]: normalizeDay(d) }));
        })
        .catch(() => {});
    },
    [latest, latestErrors, fetchDay],
  );

  const setPunches = useCallback(
    async (date: string, punches: Punch[]) => {
      const normalized = normalizePunches(punches);
      setDays((prev) => withDay(prev, date, (d) => ({ ...d, punches: normalized })));
      await sendLatest(`punches:${date}`, date, normalized, (p) => api.putPunches(date, p));
    },
    [sendLatest],
  );

  const setPriorities = useCallback(
    (date: string, priorities: Priority[]) => {
      setDays((prev) => withDay(prev, date, (d) => ({ ...d, priorities })));
      return sendLatest(`priorities:${date}`, date, priorities, (p) => api.putPriorities(date, p));
    },
    [sendLatest],
  );

  const addPriority = useCallback(
    async (date: string, text: string) => {
      const uid = newUid();
      const next = placePriority(latest.current[date]?.priorities ?? [], priorityCount.current, text, uid, Date.now());
      if (!next) throw new Error('The priorities list is full.');
      // A timer must not start against a uid the server never stored.
      if (!(await setPriorities(date, next))) throw new Error(SAVE_FAILED.title);
      return uid;
    },
    [setPriorities, latest, priorityCount],
  );

  const setRetro = useCallback(
    async (date: string, patch: { note?: string; done?: boolean }) => {
      setDays((prev) =>
        withDay(prev, date, (d) => ({
          ...d,
          retroNote: patch.note ?? d.retroNote,
          retroAt: patch.done === undefined ? d.retroAt : patch.done ? (d.retroAt ?? Date.now()) : null,
        })),
      );
      await inOrder(`day:${date}`, date, async () => {
        const saved = await api.putRetro(date, patch);
        setDays((prev) => withDay(prev, date, (d) => ({ ...d, retroAt: saved.retroAt })));
      });
    },
    [inOrder],
  );

  const setOvertimeApproved = useCallback(
    async (date: string, approved: boolean) => {
      setDays((prev) => withDay(prev, date, (d) => ({ ...d, overtimeApproved: approved })));
      await inOrder(`day:${date}`, date, () => api.putOvertime(date, approved));
    },
    [inOrder],
  );

  const setWorkMinutes = useCallback(
    async (date: string, minutes: number | null) => {
      setDays((prev) => withDay(prev, date, (d) => ({ ...d, workMinutes: minutes })));
      await inOrder(`day:${date}`, date, () => api.putTarget(date, minutes));
    },
    [inOrder],
  );

  const applySession = useCallback((session: Session) => {
    // The server just confirmed this row: fresher than any refresh already on its way.
    mutationSeq.current++;
    setDays((prev) =>
      withDay(prev, session.date, (d) => {
        const others = d.sessions.filter((s) => s.id !== session.id);
        const next = session.status === 'cancelled' ? others : [...others, session];
        next.sort((a, b) => a.startedAt - b.startedAt);
        // A session starting ended the running break on the server; the same here.
        const breaks = session.status === 'running' ? endBreaksAt(d.breaks, session.startedAt) : d.breaks;
        return { ...d, sessions: next, breaks };
      }),
    );
  }, []);

  const removeSession = useCallback(
    async (date: string, id: number) => {
      setDays((prev) => withDay(prev, date, (d) => ({ ...d, sessions: d.sessions.filter((s) => s.id !== id) })));
      await inOrder(`session:${id}`, date, () => api.deleteSession(id));
    },
    [inOrder],
  );

  // Not optimistic (the row keeps the stored label until the PATCH answers), so nothing to
  // put back; the banner still applies: the user pressed Enter and nothing changed.
  const updateSession = useCallback(
    async (id: number, patch: { label?: string; notes?: string; priorityUid?: string | null }) => {
      await inOrder(`session:${id}`, null, async () => {
        const { session } = await api.patchSession(id, patch);
        applySession(session);
      });
    },
    [applySession, inOrder],
  );

  // Break writes share one queue: an end or a delete never passes the start before it.
  const startBreak = useCallback(
    async (date: string, plannedSeconds: number) => {
      await inOrder('breaks', null, async () => {
        const { break: saved } = await api.startBreak(date, plannedSeconds);
        // The server ended the one still running when this one started; the same here, so the
        // log doesn't show two running until the next refresh.
        setDays((prev) => withDay(prev, date, (d) => ({ ...d, breaks: [...endBreaksAt(d.breaks, saved.startedAt), saved] })));
      });
    },
    [inOrder],
  );

  // At once on screen: cut short now, or gone if it ran under a minute. The server's answer
  // then stands, a null one meaning it dropped the break.
  const endBreak = useCallback(
    async (date: string, id: number) => {
      const now = Date.now();
      setDays((prev) => withDay(prev, date, (d) => ({ ...d, breaks: d.breaks.flatMap((b) => (b.id === id ? endBreaksAt([b], now) : [b])) })));
      await inOrder('breaks', date, async () => {
        const { break: saved } = await api.endBreak(id);
        setDays((prev) =>
          withDay(prev, date, (d) => {
            const others = d.breaks.filter((b) => b.id !== id);
            return { ...d, breaks: saved ? [...others, saved].sort((a, b) => a.startedAt - b.startedAt) : others };
          }),
        );
      });
    },
    [inOrder],
  );

  const removeBreak = useCallback(
    async (date: string, id: number) => {
      setDays((prev) => withDay(prev, date, (d) => ({ ...d, breaks: d.breaks.filter((b) => b.id !== id) })));
      await inOrder('breaks', date, () => api.deleteBreak(id));
    },
    [inOrder],
  );

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
 * Keeps a day that is on screen in step with the server: a refresh when the tab comes back
 * (throttled, like the timer's sync; no `focus` listener, see the gotcha in AGENTS.md) and
 * every minute, which also asks again for a day whose first load failed. Returns true while a
 * come-back refresh is out, so the caller can wait for the answer before judging alarms on a
 * copy that may be hours old.
 */
export function useRefreshDay(date: string): boolean {
  const { refresh } = useDayStore();
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let last = 0;
    const tick = (): Promise<void> | null => {
      const t = Date.now();
      if (t - last < 5000) return null;
      last = t;
      return refresh(date);
    };
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const p = tick();
      if (!p) return;
      setPending(true);
      void p.finally(() => setPending(false));
    };
    const id = setInterval(() => void tick(), MINUTE_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [date, refresh]);
  return pending;
}
