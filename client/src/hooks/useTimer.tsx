import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as api from '../api';
import type { Session } from '../types';
import { alert, dismissByTag, unlockAudio, warnQuietly } from '../lib/alerts';
import { SAVE_FAILED, TIMER_DONE, TIMER_DUE, TIMER_ELSEWHERE, TIMER_PAUSED_OUT } from '../lib/copy';
import { formatCountdown, formatDuration } from '../lib/format';
import { readStored, writeStored } from '../lib/storage';
import { activeMs, DUE_GRACE_SECONDS, dueKey, PAUSE_LIMIT_SECONDS, timerView, type TimerView } from '../lib/timer';
import { useDayStore } from './useDay';
import { useLatest } from './useLatest';
import { useNow } from './useNow';
import { useSettings } from './useSettings';
import { useWakeLock } from './useWakeLock';

interface TimerCtx {
  running: Session | null;
  /** Seconds left; 0 once complete. Derived from the server's startedAt and pauses every tick. */
  remainingSeconds: number;
  elapsedSeconds: number;
  /** 0..1 */
  progress: number;
  paused: boolean;
  /** The planned time is used up; the session waits for more time or a finish. */
  due: boolean;
  overrunSeconds: number;
  start: (date: string, plannedSeconds: number, label: string, priorityUid?: string | null) => Promise<void>;
  /** Mid-session, ± the planned length; once due, +N is N more minutes from now. */
  adjust: (deltaSeconds: number) => Promise<void>;
  setLabel: (label: string) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  /** `countOverrun` logs the time past the planned end too; otherwise a late finish logs the plan. */
  finish: (countOverrun?: boolean) => Promise<void>;
  /**
   * The Finish button: finishes now, unless the timer is a whole minute or more past its end,
   * where the planned and the worked length differ and `finishChoice` asks which one to log.
   */
  requestFinish: () => void;
  finishChoice: boolean;
  dismissFinishChoice: () => void;
  cancel: () => Promise<void>;
}

const Ctx = createContext<TimerCtx | null>(null);
const BASE_TITLE = 'Clockspan';
const IDLE: TimerView = { elapsedSeconds: 0, remainingSeconds: 0, progress: 0, endAt: 0, paused: false, pausedForSeconds: 0, due: false, overrunSeconds: 0 };

// The last planned end that was announced, kept across reloads so the chime plays once per
// end. With storage blocked (private mode) a reload may chime again, nothing worse.
const DUE_STORAGE_KEY = 'focus:timer-due';

export function TimerProvider({ children }: { children: ReactNode }) {
  const [running, setRunning] = useState<Session | null>(null);
  const [finishChoice, setFinishChoice] = useState(false);
  // Latest value for callbacks so rapid clicks (−5m, −5m) compound instead of racing.
  const runningRef = useLatest<Session | null>(running);
  const now = useNow(1000);
  // `loaded` gates the two effects that alert: on a fresh load the running session can answer
  // before the settings do, and an alert then would use the default sound and volume switch.
  const { settings, loaded } = useSettings();
  const store = useDayStore();
  // `sync` reads the store through a ref so it stays one function for the provider's lifetime.
  const storeRef = useLatest(store);
  const completing = useRef(false);
  // After a failed finish (server unreachable) wait before trying again, doubling up to a
  // minute. The server clamps ended_at to the planned end, so a late finish still logs the
  // planned duration; all a wait costs is the chime's promptness.
  const retry = useRef({ at: 0, delay: 0 });

  // Re-sync with the server on load, when the tab comes back, and every minute. A
  // response is dropped if a local mutation happened after the request was sent, so a
  // slow GET can never overwrite a fresh optimistic update. A different answer than the one
  // shown means another device started or ended a timer: its day is reloaded so the log
  // shows the row this device never wrote.
  const mutationSeq = useRef(0);
  const lastSync = useRef(0);
  const sync = useCallback(
    (force = false) => {
      const t = Date.now();
      if (!force && t - lastSync.current < 5000) return;
      lastSync.current = t;
      const seq = mutationSeq.current;
      api
        .getRunning()
        .then(({ session }) => {
          if (mutationSeq.current !== seq) return;
          const prev = runningRef.current;
          setRunning(session);
          if (prev?.id === session?.id) return;
          for (const date of new Set([prev?.date, session?.date])) if (date) void storeRef.current.load(date);
        })
        .catch(() => {});
    },
    [runningRef, storeRef],
  );
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

  const { elapsedSeconds, remainingSeconds, progress, endAt, paused, pausedForSeconds, due, overrunSeconds } = running ? timerView(running, now) : IDLE;

  // Completion without the user: a timer that ran out and waited DUE_GRACE_SECONDS for an
  // answer (or expired while the page was closed — the server clamps ended_at to the planned
  // end either way), or a pause left for an hour (the server ends the session where the pause
  // began, so nothing after it is logged).
  useEffect(() => {
    if (!running || !loaded || completing.current || now < retry.current.at) return;
    const forgotten = pausedForSeconds >= PAUSE_LIMIT_SECONDS;
    if (!(due && overrunSeconds >= DUE_GRACE_SECONDS) && !forgotten) return;
    completing.current = true;
    mutationSeq.current++;
    const session = running;
    api
      .finishSession(session.id)
      .then(({ session: done }) => {
        retry.current = { at: 0, delay: 0 };
        store.applySession(done);
        setRunning(null);
        // Cancelled on another device before this one heard: nothing to celebrate.
        if (done.status !== 'completed') return;
        if (forgotten) {
          alert({
            title: TIMER_PAUSED_OUT.title,
            body: TIMER_PAUSED_OUT.body(session.label, formatDuration(done.durationSeconds ?? 0)),
            tone: 'info',
            tag: 'timer-complete',
            sound: false,
            notifications: false,
          });
          return;
        }
        // The chime played when the end came, unless the page was closed then.
        const chimed = readStored(DUE_STORAGE_KEY) === dueKey(session.id, endAt);
        alert({
          title: TIMER_DONE.title,
          body: TIMER_DONE.body(session.label, formatCountdown(done.durationSeconds ?? 0)),
          tone: 'success',
          chime: settings.sounds.timer,
          tag: 'timer-complete',
          sound: !chimed && settings.sound,
          notifications: !chimed && settings.notifications,
        });
      })
      .catch(() => {
        const delay = Math.min(60_000, retry.current.delay ? retry.current.delay * 2 : 2_000);
        retry.current = { at: Date.now() + delay, delay };
      })
      .finally(() => {
        completing.current = false;
      });
  }, [running, loaded, now, endAt, due, overrunSeconds, pausedForSeconds, store, settings.sound, settings.sounds.timer, settings.notifications]);

  useWakeLock(running != null && !paused && !due && settings.keepScreenAwake);

  useEffect(() => {
    document.title = running
      ? `${paused ? 'Paused ' : ''}${formatCountdown(due ? -overrunSeconds : remainingSeconds)}${running.label ? ` · ${running.label}` : ''} — ${BASE_TITLE}`
      : BASE_TITLE;
  }, [running, remainingSeconds, overrunSeconds, paused, due]);

  const start = useCallback(
    async (date: string, plannedSeconds: number, label: string, priorityUid: string | null = null) => {
      unlockAudio(); // user gesture: lets the completion chime play later on iOS
      mutationSeq.current++;
      try {
        const { session } = await api.startSession(date, plannedSeconds, label, priorityUid);
        setRunning(session);
        store.applySession(session);
      } catch (err) {
        const body = (err as { body?: { session?: Session } }).body;
        if (!body?.session) throw err;
        // 409: a timer is already running, started on another device. Follow it, fetch its
        // day so the log has the row, and say why what was typed here went nowhere.
        setRunning(body.session);
        void store.load(body.session.date);
        alert({ ...TIMER_ELSEWHERE, tone: 'info', tag: 'timer-elsewhere', sound: false, notifications: false });
      }
    },
    [store],
  );

  // The bar and the card call these with `void`, so a failure has to be reported here: the
  // running state is what the server last confirmed, and the banner says the press was lost.
  const attempt = useCallback(
    async (run: () => Promise<void>) => {
      try {
        await run();
      } catch (err) {
        warnQuietly({ title: SAVE_FAILED.title, body: SAVE_FAILED.body, tag: 'save-failed' });
        // Gone, or no longer running: it ended on another device. Show that now, not at the
        // next poll.
        const status = (err as { status?: number }).status;
        if (status === 404 || status === 409) sync(true);
      }
    },
    [sync],
  );

  const adjust = useCallback(
    (deltaSeconds: number) =>
      attempt(async () => {
        const cur = runningRef.current;
        if (!cur) return;
        mutationSeq.current++;
        const elapsed = Math.floor(activeMs(cur, Date.now()) / 1000);
        // Once the plan is used up, "+5" means five more minutes from now, not from the end.
        const next = Math.max(60, Math.max(cur.plannedSeconds, elapsed) + deltaSeconds);
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
        } catch (err) {
          setRunning(cur);
          throw err;
        }
      }),
    [attempt, store, runningRef],
  );

  const setLabel = useCallback(
    (label: string) =>
      attempt(async () => {
        const cur = runningRef.current;
        if (!cur) return;
        mutationSeq.current++;
        setRunning({ ...cur, label });
        try {
          const { session } = await api.patchSession(cur.id, { label });
          setRunning((latest) => (latest && latest.id === session.id ? { ...latest, label: session.label } : latest));
        } catch (err) {
          setRunning((latest) => (latest && latest.id === cur.id ? { ...latest, label: cur.label } : latest));
          throw err;
        }
      }),
    [attempt, runningRef],
  );

  // Pause and resume are optimistic like adjust; the server's row is adopted only if the
  // user hasn't flipped it again meanwhile, and a failure puts the pause fields back.
  const pause = useCallback(
    () =>
      attempt(async () => {
        const cur = runningRef.current;
        if (!cur || cur.pausedAt != null) return;
        mutationSeq.current++;
        const optimistic = { ...cur, pausedAt: Date.now() };
        runningRef.current = optimistic;
        setRunning(optimistic);
        try {
          const { session } = await api.pauseSession(cur.id);
          store.applySession(session); // the log row's pill reads the day's copy
          setRunning((latest) => (latest && latest.id === session.id && latest.pausedAt != null ? session : latest));
        } catch (err) {
          setRunning((latest) => (latest && latest.id === cur.id ? { ...latest, pausedAt: cur.pausedAt, pausedSeconds: cur.pausedSeconds } : latest));
          throw err;
        }
      }),
    [attempt, store, runningRef],
  );

  const resume = useCallback(
    () =>
      attempt(async () => {
        const cur = runningRef.current;
        if (!cur || cur.pausedAt == null) return;
        mutationSeq.current++;
        const optimistic = { ...cur, pausedAt: null, pausedSeconds: cur.pausedSeconds + Math.round((Date.now() - cur.pausedAt) / 1000) };
        runningRef.current = optimistic;
        setRunning(optimistic);
        try {
          const { session } = await api.resumeSession(cur.id);
          store.applySession(session);
          setRunning((latest) => (latest && latest.id === session.id && latest.pausedAt == null ? session : latest));
        } catch (err) {
          setRunning((latest) => (latest && latest.id === cur.id ? { ...latest, pausedAt: cur.pausedAt, pausedSeconds: cur.pausedSeconds } : latest));
          throw err;
        }
      }),
    [attempt, store, runningRef],
  );

  const finish = useCallback(
    (countOverrun = false) =>
      attempt(async () => {
        setFinishChoice(false);
        const cur = runningRef.current;
        if (!cur) return;
        mutationSeq.current++;
        const { session } = await api.finishSession(cur.id, countOverrun);
        store.applySession(session);
        setRunning(null);
      }),
    [attempt, store, runningRef],
  );

  const requestFinish = useCallback(() => {
    const cur = runningRef.current;
    if (!cur) return;
    const v = timerView(cur, Date.now());
    // Under a minute over, both lengths read the same: nothing to ask.
    if (v.due && formatDuration(v.elapsedSeconds) !== formatDuration(cur.plannedSeconds)) setFinishChoice(true);
    else void finish();
  }, [finish, runningRef]);
  const dismissFinishChoice = useCallback(() => setFinishChoice(false), []);

  const cancel = useCallback(
    () =>
      attempt(async () => {
        setFinishChoice(false);
        const cur = runningRef.current;
        if (!cur) return;
        mutationSeq.current++;
        const { session } = await api.cancelSession(cur.id);
        store.applySession(session);
        setRunning(null);
      }),
    [attempt, store, runningRef],
  );

  // Time's up: announce once per (session, planned end) and leave the session open for an
  // answer. A reload inside the grace shows the banner again but does not chime (the key is
  // in localStorage); adding time moves the end and re-arms. The banner goes when the timer
  // is no longer due: finished, given time, cancelled, or ended on another device.
  const announced = useRef<string | null>(null);
  const step = settings.adjustStepMinutes;
  useEffect(() => {
    if (!running || !due) {
      dismissByTag('timer-due');
      return;
    }
    if (!loaded || overrunSeconds >= DUE_GRACE_SECONDS) return;
    const key = dueKey(running.id, endAt);
    if (announced.current === key) return;
    announced.current = key;
    const fresh = readStored(DUE_STORAGE_KEY) !== key;
    writeStored(DUE_STORAGE_KEY, key);
    alert({
      title: TIMER_DUE.title,
      body: TIMER_DUE.body(running.label, formatDuration(running.plannedSeconds)),
      tone: 'info',
      sticky: true,
      chime: settings.sounds.timer,
      tag: 'timer-due',
      action: { label: TIMER_DUE.more(step), run: () => void adjust(step * 60) },
      sound: fresh && settings.sound,
      notifications: fresh && settings.notifications,
    });
  }, [running, loaded, due, overrunSeconds, endAt, step, adjust, settings.sound, settings.sounds.timer, settings.notifications]);

  const value = useMemo(
    () => ({
      running,
      remainingSeconds,
      elapsedSeconds,
      progress,
      paused,
      due,
      overrunSeconds,
      start,
      adjust,
      setLabel,
      pause,
      resume,
      finish,
      requestFinish,
      finishChoice: finishChoice && running != null,
      dismissFinishChoice,
      cancel,
    }),
    [
      running,
      remainingSeconds,
      elapsedSeconds,
      progress,
      paused,
      due,
      overrunSeconds,
      start,
      adjust,
      setLabel,
      pause,
      resume,
      finish,
      requestFinish,
      finishChoice,
      dismissFinishChoice,
      cancel,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTimer(): TimerCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTimer outside TimerProvider');
  return v;
}
