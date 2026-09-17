import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as api from '../api';
import type { Day, Priority, Punch, Session } from '../types';
import { alert } from '../lib/alerts';
import { SAVE_FAILED } from '../lib/copy';
import { newUid, placePriority } from '../lib/priorities';
import { emptyPunches, normalizePunches } from '../lib/timeclock';
import { useLatest } from './useLatest';
import { useSettings } from './useSettings';

/**
 * The setters are optimistic and never reject: a failed save puts the server's copy back and
 * raises a banner, so a `void store.x()` call site is complete. `setPriorities` also says
 * whether it saved, for the one caller that chains on it (`addPriority`). Punch saves are
 * queued per day (one in flight, the newest waiting) so a burst of arrow keys lands in order.
 */
interface DayStore {
  days: Record<string, Day>;
  load: (date: string) => Promise<void>;
  setPunches: (date: string, punches: Punch[]) => Promise<void>;
  setPriorities: (date: string, priorities: Priority[]) => Promise<boolean>;
  /** Add a priority from outside the card (the timer). Resolves to its uid; rejects if it could not be saved. */
  addPriority: (date: string, text: string) => Promise<string>;
  setOvertimeApproved: (date: string, approved: boolean) => Promise<void>;
  setRetro: (date: string, patch: { note?: string; done?: boolean }) => Promise<void>;
  /** Insert or replace a session in its day (used by the timer when one completes). */
  applySession: (session: Session) => void;
  removeSession: (date: string, id: number) => Promise<void>;
  updateSession: (id: number, patch: { label?: string; notes?: string; priorityUid?: string | null }) => Promise<void>;
}

const Ctx = createContext<DayStore | null>(null);

function withDay(days: Record<string, Day>, date: string, fn: (d: Day) => Day): Record<string, Day> {
  const current = days[date] ?? { date, punches: emptyPunches(), priorities: [], overtimeApproved: false, retroNote: '', retroAt: null, sessions: [] };
  return { ...days, [date]: fn(current) };
}

export function DayProvider({ children }: { children: ReactNode }) {
  const [days, setDays] = useState<Record<string, Day>>({});
  // For callbacks that read before they write (addPriority): a click right after a priority
  // blur-flush must see the flushed list, not the render it closed over.
  const latest = useLatest(days);
  const { settings } = useSettings();
  const priorityCount = useLatest(settings.priorityCount);
  const inflight = useRef(new Map<string, Promise<void>>());
  const punchQueue = useRef(new Map<string, { latest: Punch[]; inflight: boolean }>());

  const load = useCallback((date: string) => {
    const existing = inflight.current.get(date);
    if (existing) return existing;
    const p = api
      .getDay(date)
      .then((d) => {
        setDays((prev) => ({ ...prev, [date]: { ...d, punches: normalizePunches(d.punches) } }));
      })
      .finally(() => inflight.current.delete(date));
    inflight.current.set(date, p);
    return p;
  }, []);

  // Every write ends here: on failure the server's copy replaces an optimistic guess (`date`
  // null when there was none) and a banner says so, since the edit vanishing on its own would
  // look like the app losing data.
  const persist = useCallback(
    async (date: string | null, run: () => Promise<unknown>): Promise<boolean> => {
      try {
        await run();
        return true;
      } catch {
        if (date) void load(date);
        alert({ title: SAVE_FAILED.title, body: SAVE_FAILED.body, tone: 'danger', tag: 'save-failed', sound: false, notifications: false });
        return false;
      }
    },
    [load],
  );

  // A PUT replaces the whole day's punches, so two in flight could land out of order. Only
  // one runs per day; a newer set waits and goes out after it, and the sets in between are
  // skipped. A failed save drops the queue: `persist` has reloaded the day by then.
  const setPunches = useCallback(
    async (date: string, punches: Punch[]) => {
      const normalized = normalizePunches(punches);
      setDays((prev) => withDay(prev, date, (d) => ({ ...d, punches: normalized })));
      const q = punchQueue.current.get(date) ?? { latest: normalized, inflight: false };
      q.latest = normalized;
      punchQueue.current.set(date, q);
      if (q.inflight) return;
      q.inflight = true;
      try {
        let sent: Punch[] | null = null;
        while (sent !== q.latest) {
          sent = q.latest;
          const batch = sent;
          if (!(await persist(date, () => api.putPunches(date, batch)))) break;
        }
      } finally {
        punchQueue.current.delete(date);
      }
    },
    [persist],
  );

  const setPriorities = useCallback(
    async (date: string, priorities: Priority[]) => {
      setDays((prev) => withDay(prev, date, (d) => ({ ...d, priorities })));
      return persist(date, () => api.putPriorities(date, priorities));
    },
    [persist],
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
      await persist(date, async () => {
        const saved = await api.putRetro(date, patch);
        setDays((prev) => withDay(prev, date, (d) => ({ ...d, retroAt: saved.retroAt })));
      });
    },
    [persist],
  );

  const setOvertimeApproved = useCallback(
    async (date: string, approved: boolean) => {
      setDays((prev) => withDay(prev, date, (d) => ({ ...d, overtimeApproved: approved })));
      await persist(date, () => api.putOvertime(date, approved));
    },
    [persist],
  );

  const applySession = useCallback((session: Session) => {
    setDays((prev) =>
      withDay(prev, session.date, (d) => {
        const others = d.sessions.filter((s) => s.id !== session.id);
        const next = session.status === 'cancelled' ? others : [...others, session];
        next.sort((a, b) => a.startedAt - b.startedAt);
        return { ...d, sessions: next };
      }),
    );
  }, []);

  const removeSession = useCallback(
    async (date: string, id: number) => {
      setDays((prev) => withDay(prev, date, (d) => ({ ...d, sessions: d.sessions.filter((s) => s.id !== id) })));
      await persist(date, () => api.deleteSession(id));
    },
    [persist],
  );

  // Not optimistic (the row keeps the stored label until the PATCH answers), so nothing to
  // put back; the banner still applies: the user pressed Enter and nothing changed.
  const updateSession = useCallback(
    async (id: number, patch: { label?: string; notes?: string; priorityUid?: string | null }) => {
      await persist(null, async () => {
        const { session } = await api.patchSession(id, patch);
        applySession(session);
      });
    },
    [applySession, persist],
  );

  const value = useMemo(
    () => ({ days, load, setPunches, setPriorities, addPriority, setOvertimeApproved, setRetro, applySession, removeSession, updateSession }),
    [days, load, setPunches, setPriorities, addPriority, setOvertimeApproved, setRetro, applySession, removeSession, updateSession],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDayStore(): DayStore {
  const v = useContext(Ctx);
  if (!v) throw new Error('useDayStore outside DayProvider');
  return v;
}

/** The day for a date key, loading it on first use. */
export function useDay(date: string): { day: Day | undefined; store: DayStore } {
  const store = useDayStore();
  const day = store.days[date];
  useEffect(() => {
    if (!day) void store.load(date);
  }, [date, day, store]);
  return { day, store };
}
