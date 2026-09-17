import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as api from '../api';
import type { Day, Priority, Punch, Session } from '../types';
import { newUid, placePriority } from '../lib/priorities';
import { normalizePunches } from '../lib/timeclock';
import { useSettings } from './useSettings';

interface DayStore {
  days: Record<string, Day>;
  load: (date: string) => Promise<void>;
  setPunches: (date: string, punches: Punch[]) => Promise<void>;
  setPriorities: (date: string, priorities: Priority[]) => Promise<void>;
  /** Add a priority from outside the card (the timer). Resolves to its uid. */
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
  const current = days[date] ?? { date, punches: normalizePunches([]), priorities: [], overtimeApproved: false, retroNote: '', retroAt: null, sessions: [] };
  return { ...days, [date]: fn(current) };
}

export function DayProvider({ children }: { children: ReactNode }) {
  const [days, setDays] = useState<Record<string, Day>>({});
  // Latest value for callbacks that read before they write (addPriority), so a click right
  // after a priority blur-flush sees the flushed list, not the render it closed over.
  const latest = useRef(days);
  latest.current = days;
  const { settings } = useSettings();
  const priorityCount = useRef(settings.priorityCount);
  priorityCount.current = settings.priorityCount;
  const inflight = useRef(new Map<string, Promise<void>>());

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

  const setPunches = useCallback(
    async (date: string, punches: Punch[]) => {
      const normalized = normalizePunches(punches);
      setDays((prev) => withDay(prev, date, (d) => ({ ...d, punches: normalized })));
      try {
        await api.putPunches(date, normalized);
      } catch (err) {
        void load(date);
        throw err;
      }
    },
    [load],
  );

  const setPriorities = useCallback(
    async (date: string, priorities: Priority[]) => {
      setDays((prev) => withDay(prev, date, (d) => ({ ...d, priorities })));
      try {
        await api.putPriorities(date, priorities);
      } catch (err) {
        void load(date);
        throw err;
      }
    },
    [load],
  );

  const addPriority = useCallback(
    async (date: string, text: string) => {
      const uid = newUid();
      const next = placePriority(latest.current[date]?.priorities ?? [], priorityCount.current, text, uid, Date.now());
      if (!next) throw new Error('The priorities list is full.');
      await setPriorities(date, next);
      return uid;
    },
    [setPriorities],
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
      try {
        const saved = await api.putRetro(date, patch);
        setDays((prev) => withDay(prev, date, (d) => ({ ...d, retroAt: saved.retroAt })));
      } catch (err) {
        void load(date);
        throw err;
      }
    },
    [load],
  );

  const setOvertimeApproved = useCallback(
    async (date: string, approved: boolean) => {
      setDays((prev) => withDay(prev, date, (d) => ({ ...d, overtimeApproved: approved })));
      try {
        await api.putOvertime(date, approved);
      } catch (err) {
        void load(date);
        throw err;
      }
    },
    [load],
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

  const removeSession = useCallback(async (date: string, id: number) => {
    setDays((prev) => withDay(prev, date, (d) => ({ ...d, sessions: d.sessions.filter((s) => s.id !== id) })));
    await api.deleteSession(id);
  }, []);

  const updateSession = useCallback(
    async (id: number, patch: { label?: string; notes?: string; priorityUid?: string | null }) => {
      const { session } = await api.patchSession(id, patch);
      applySession(session);
    },
    [applySession],
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
  }, [date, day === undefined]);
  return { day, store };
}
