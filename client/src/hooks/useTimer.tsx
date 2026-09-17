import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as api from '../api';
import type { Session } from '../types';
import { alert, unlockAudio } from '../lib/alerts';
import { formatCountdown } from '../lib/format';
import { useDayStore } from './useDay';
import { useNow } from './useNow';
import { useSettings } from './useSettings';
import { useWakeLock } from './useWakeLock';

interface TimerCtx {
  running: Session | null;
  /** Seconds left; 0 once complete. Derived from the server's startedAt every tick. */
  remainingSeconds: number;
  elapsedSeconds: number;
  /** 0..1 */
  progress: number;
  start: (date: string, plannedSeconds: number, label: string, priorityUid?: string | null) => Promise<void>;
  adjust: (deltaSeconds: number) => Promise<void>;
  setLabel: (label: string) => Promise<void>;
  finish: () => Promise<void>;
  cancel: () => Promise<void>;
}

const Ctx = createContext<TimerCtx | null>(null);
const BASE_TITLE = 'Clockspan';

export function TimerProvider({ children }: { children: ReactNode }) {
  const [running, setRunning] = useState<Session | null>(null);
  // Latest value for callbacks so rapid clicks (−5m, −5m) compound instead of racing.
  const runningRef = useRef<Session | null>(null);
  runningRef.current = running;
  const now = useNow(1000);
  const { settings } = useSettings();
  const store = useDayStore();
  const completing = useRef(false);

  // Re-sync with the server on load, when the tab comes back, and every minute. A
  // response is dropped if a local mutation happened after the request was sent, so a
  // slow GET can never overwrite a fresh optimistic update.
  const mutationSeq = useRef(0);
  const lastSync = useRef(0);
  const sync = useCallback((force = false) => {
    const t = Date.now();
    if (!force && t - lastSync.current < 5000) return;
    lastSync.current = t;
    const seq = mutationSeq.current;
    api
      .getRunning()
      .then(({ session }) => {
        if (mutationSeq.current === seq) setRunning(session);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    sync(true);
    const onVisible = () => {
      if (document.visibilityState === 'visible') sync();
    };
    const id = setInterval(() => sync(), 60_000);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [sync]);

  const endAt = running ? running.startedAt + running.plannedSeconds * 1000 : 0;
  const elapsedSeconds = running ? Math.max(0, Math.floor((now - running.startedAt) / 1000)) : 0;
  const remainingSeconds = running ? Math.max(0, Math.ceil((endAt - now) / 1000)) : 0;
  const progress = running ? Math.min(1, elapsedSeconds / running.plannedSeconds) : 0;

  // Completion: the planned end has passed. Also covers a timer that expired while the
  // page was closed — the server clamps ended_at to the planned end.
  useEffect(() => {
    if (!running || now < endAt || completing.current) return;
    completing.current = true;
    mutationSeq.current++;
    const session = running;
    api
      .finishSession(session.id)
      .then(({ session: done }) => {
        store.applySession(done);
        setRunning(null);
        alert({
          title: 'Focus session complete',
          body: session.label ? `${session.label} — ${formatCountdown(done.durationSeconds ?? 0)}` : 'Nice work. Take a breath.',
          tone: 'success',
          chime: 'timer',
          tag: 'timer-complete',
          sound: settings.sound,
          notifications: settings.notifications,
        });
      })
      .catch(() => {})
      .finally(() => {
        completing.current = false;
      });
  }, [running, now, endAt, store, settings.sound, settings.notifications]);

  useWakeLock(running != null && settings.keepScreenAwake);

  useEffect(() => {
    document.title = running ? `${formatCountdown(remainingSeconds)}${running.label ? ` · ${running.label}` : ''} — ${BASE_TITLE}` : BASE_TITLE;
  }, [running, remainingSeconds]);

  const start = useCallback(async (date: string, plannedSeconds: number, label: string, priorityUid: string | null = null) => {
    unlockAudio(); // user gesture: lets the completion chime play later on iOS
    mutationSeq.current++;
    try {
      const { session } = await api.startSession(date, plannedSeconds, label, priorityUid);
      setRunning(session);
      store.applySession(session);
    } catch (err) {
      const body = (err as { body?: { session?: Session } }).body;
      if (body?.session) setRunning(body.session); // 409: adopt the one already running
      else throw err;
    }
  }, [store]);

  const adjust = useCallback(
    async (deltaSeconds: number) => {
      const cur = runningRef.current;
      if (!cur) return;
      mutationSeq.current++;
      const elapsed = Math.floor((Date.now() - cur.startedAt) / 1000);
      const next = Math.max(60, cur.plannedSeconds + deltaSeconds);
      if (next <= elapsed) {
        // Shrinking below what's already elapsed means "I'm done now".
        const { session } = await api.finishSession(cur.id);
        store.applySession(session);
        setRunning(null);
        return;
      }
      const optimistic = { ...cur, plannedSeconds: next };
      runningRef.current = optimistic;
      setRunning(optimistic);
      try {
        const { session } = await api.patchSession(cur.id, { plannedSeconds: next });
        // Only adopt the response if nothing newer happened meanwhile.
        setRunning((latest) => (latest && latest.id === session.id && latest.plannedSeconds === next ? session : latest));
      } catch {
        setRunning(cur);
      }
    },
    [store],
  );

  const setLabel = useCallback(async (label: string) => {
    const cur = runningRef.current;
    if (!cur) return;
    mutationSeq.current++;
    setRunning({ ...cur, label });
    const { session } = await api.patchSession(cur.id, { label });
    setRunning((latest) => (latest && latest.id === session.id ? { ...latest, label: session.label } : latest));
  }, []);

  const finish = useCallback(async () => {
    if (!running) return;
    mutationSeq.current++;
    const { session } = await api.finishSession(running.id);
    store.applySession(session);
    setRunning(null);
  }, [running, store]);

  const cancel = useCallback(async () => {
    if (!running) return;
    mutationSeq.current++;
    const { session } = await api.cancelSession(running.id);
    store.applySession(session);
    setRunning(null);
  }, [running, store]);

  const value = useMemo(
    () => ({ running, remainingSeconds, elapsedSeconds, progress, start, adjust, setLabel, finish, cancel }),
    [running, remainingSeconds, elapsedSeconds, progress, start, adjust, setLabel, finish, cancel],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTimer(): TimerCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTimer outside TimerProvider');
  return v;
}
