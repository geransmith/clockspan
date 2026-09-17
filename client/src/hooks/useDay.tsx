import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as api from '../api';
import type { Day, Priority, Punch, Session } from '../types';
import { normalizePunches } from '../lib/timeclock';

interface DayStore {
  days: Record<string, Day>;
  load: (date: string) => Promise<void>;
  setPunches: (date: string, punches: Punch[]) => Promise<void>;
  setPriorities: (date: string, priorities: Priority[]) => Promise<void>;
  /** Insert or replace a session in its day (used by the timer when one completes). */
  applySession: (session: Session) => void;
  removeSession: (date: string, id: number) => Promise<void>;
  updateSession: (id: number, patch: { label?: string; notes?: string }) => Promise<void>;
}

const Ctx = createContext<DayStore | null>(null);

function withDay(days: Record<string, Day>, date: string, fn: (d: Day) => Day): Record<string, Day> {
  const current = days[date] ?? { date, punches: normalizePunches([]), priorities: emptyPriorities(), sessions: [] };
  return { ...days, [date]: fn(current) };
}

function emptyPriorities(): Priority[] {
  return [1, 2, 3].map((position) => ({ position: position as 1 | 2 | 3, text: '', done: false }));
}

export function DayProvider({ children }: { children: ReactNode }) {
  const [days, setDays] = useState<Record<string, Day>>({});
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
    async (id: number, patch: { label?: string; notes?: string }) => {
      const { session } = await api.patchSession(id, patch);
      applySession(session);
    },
    [applySession],
  );

  const value = useMemo(
    () => ({ days, load, setPunches, setPriorities, applySession, removeSession, updateSession }),
    [days, load, setPunches, setPriorities, applySession, removeSession, updateSession],
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
