import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as api from '../api';
import { nextBackoff } from '../../../shared/backoff.js';
import { activeMs, PLANNED_SECONDS } from '../../../shared/timer.js';
import type { Session, SessionConflict } from '../types';
import { alert, dismissByTag, unlockAudio, warnQuietly } from '../lib/alerts';
import { ApiError } from '../lib/apiError';
import { SAVE_FAILED, TIMER_DONE, TIMER_DUE, TIMER_ELSEWHERE, TIMER_PAUSED_OUT } from '../lib/copy';
import { formatCountdown, formatDuration } from '../lib/format';
import { addPending, fetched, settle, settleWith, shown, untracked, type Tracked } from '../lib/optimistic';
import { readStored, writeStored } from '../lib/storage';
import { DUE_GRACE_SECONDS, dueKey, PAUSE_LIMIT_SECONDS, timerView, type TimerView } from '../lib/timer';
import { useDayStore } from './useDay';
import { useLatest } from './useLatest';
import { useClock } from './useClock';
import { useRefreshLoop } from './useRefreshLoop';
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
  /**
   * The session last finished by hand on this device (Finish, the finish choice, or − past the
   * time worked), a fresh object each time. Not one that finished on its own after the grace or
   * a forgotten pause, or on another device: its user wasn't here to take a break after it.
   */
  finished: Session | null;
}

const Ctx = createContext<TimerCtx | null>(null);
const BASE_TITLE = 'Clockspan';
const IDLE: TimerView = { elapsedSeconds: 0, remainingSeconds: 0, progress: 0, endAt: 0, paused: false, pausedForSeconds: 0, due: false, overrunSeconds: 0 };

// The last planned end that was announced, kept across reloads so the chime plays once per
// end. With storage blocked (private mode) a reload may chime again, nothing worse.
const DUE_STORAGE_KEY = 'focus:timer-due';

export function TimerProvider({ children }: { children: ReactNode }) {
  // The running session as the server last confirmed it, plus the presses (adjust, rename,
  // pause, resume) it hasn't answered yet (`lib/optimistic.ts`); `null` confirmed is "none running".
  const [tracked, setTracked] = useState<Tracked<Session | null>>(untracked);
  // The same value, current at once: rapid presses (−5m, −5m) build on each other, and a sync's
  // answer is judged against every change made so far.
  const held = useRef(tracked);
  const change = useCallback((fn: (t: Tracked<Session | null>) => Tracked<Session | null>) => {
    held.current = fn(held.current);
    setTracked(held.current);
  }, []);
  const running = useMemo(() => shown(tracked) ?? null, [tracked]);
  const nextId = useRef(0);
  // Every write goes out once the one before it has answered, failed or not, so the server
  // ends where the screen does (two +5s in flight could land in the other order).
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const inOrder = useCallback(<T,>(send: () => Promise<T>): Promise<T> => {
    const next = queue.current.catch(() => {}).then(send);
    queue.current = next;
    return next;
  }, []);
  const [finishChoice, setFinishChoice] = useState(false);
  const [finished, setFinished] = useState<Session | null>(null);
  const now = useClock();
  // `loaded` gates the two effects that alert: on a fresh load the running session can answer
  // before the settings do, and an alert then would use the default sound and volume switch.
  const { settings, loaded } = useSettings();
  const store = useDayStore();
  // `sync` reads the store through a ref so it stays one function for the provider's lifetime.
  const storeRef = useLatest(store);
  const completing = useRef(false);
  // After a failed finish (server unreachable) wait before trying again (`nextBackoff`). The
  // server clamps ended_at to the planned end, so a late finish still logs the planned
  // duration; all a wait costs is the chime's promptness.
  const retry = useRef({ at: 0, delay: 0 });

  // Re-sync with the server on load, when the tab comes back, and every minute
  // (`useRefreshLoop`), and at once when a press finds the session gone. The answer replaces
  // the confirmed session unless the server confirmed a change after it went out, and a press
  // still on its way stays on top of it. A different session than the one shown means another
  // device started or ended a timer: its day is reloaded so the log shows the row this device
  // never wrote.
  const sync = useCallback(() => {
    const sentAt = held.current.version;
    return api
      .getRunning()
      .then(({ session }) => {
        const prev = shown(held.current) ?? null;
        const { next } = fetched(held.current, sentAt, session);
        if (next === held.current) return;
        change(() => next);
        if (prev?.id === session?.id) return;
        for (const date of new Set([prev?.date, session?.date])) if (date) void storeRef.current.load(date);
      })
      .catch(() => {});
  }, [change, storeRef]);
  useRefreshLoop(sync, true);

  // The session is over (finished or cancelled, here or by the server): nothing runs now, and
  // the day's log takes the row.
  const end = useCallback(
    async (send: () => Promise<{ session: Session }>) => {
      const { session } = await inOrder(send);
      change((t) => settleWith(t, [], null));
      store.applySession(session);
      return session;
    },
    [change, inOrder, store],
  );

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
    const session = running;
    end(() => api.finishSession(session.id))
      .then((done) => {
        retry.current = { at: 0, delay: 0 };
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
          body: TIMER_DONE.body(session.label, formatDuration(done.durationSeconds ?? 0)),
          tone: 'success',
          chime: settings.sounds.timer,
          tag: 'timer-complete',
          sound: !chimed && settings.sound,
          notifications: !chimed && settings.notifications,
        });
      })
      .catch(() => {
        const delay = nextBackoff(retry.current.delay);
        retry.current = { at: Date.now() + delay, delay };
      })
      .finally(() => {
        completing.current = false;
      });
  }, [running, loaded, now, endAt, due, overrunSeconds, pausedForSeconds, end, settings.sound, settings.sounds.timer, settings.notifications]);

  useWakeLock(running != null && !paused && !due && settings.keepScreenAwake);

  useEffect(() => {
    document.title = running
      ? `${paused ? 'Paused ' : ''}${formatCountdown(due ? -overrunSeconds : remainingSeconds)}${running.label ? ` · ${running.label}` : ''} — ${BASE_TITLE}`
      : BASE_TITLE;
  }, [running, remainingSeconds, overrunSeconds, paused, due]);

  const start = useCallback(
    async (date: string, plannedSeconds: number, label: string, priorityUid: string | null = null) => {
      unlockAudio(); // user gesture: lets the completion chime play later on iOS
      try {
        const { session } = await inOrder(() => api.startSession(date, plannedSeconds, label, priorityUid));
        change((t) => settleWith(t, [], session));
        store.applySession(session);
      } catch (err) {
        const theirs = err instanceof ApiError && err.status === 409 ? (err.body as Partial<SessionConflict> | null)?.session : undefined;
        if (!theirs) throw err;
        // 409: a timer is already running, started on another device. Follow it, fetch its
        // day so the log has the row, and say why what was typed here went nowhere.
        change((t) => settleWith(t, [], theirs));
        void store.load(theirs.date);
        alert({ ...TIMER_ELSEWHERE, tone: 'info', tag: 'timer-elsewhere', sound: false, notifications: false });
      }
    },
    [change, inOrder, store],
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
        if (err instanceof ApiError && (err.status === 404 || err.status === 409)) void sync();
      }
    },
    [sync],
  );

  // A press on the running session (adjust, rename, pause, resume): shown at once, sent after
  // the writes before it, and the server's row taken when it answers. A failure just drops the
  // change, so the screen is back on the stored row with any later press still on top. A row
  // that answers as no longer running ended elsewhere: nothing runs here either.
  const press = useCallback(
    async (cur: Session, apply: (s: Session) => Session, send: () => Promise<{ session: Session }>) => {
      const id = ++nextId.current;
      change((t) => addPending(t, id, (s) => (s && s.id === cur.id ? apply(s) : s)));
      try {
        const { session } = await inOrder(send);
        change((t) => settleWith(t, [id], session.status === 'running' ? session : null));
        return session;
      } catch (err) {
        change((t) => settle(t, [id]));
        throw err;
      }
    },
    [change, inOrder],
  );

  const adjust = useCallback(
    (deltaSeconds: number) =>
      attempt(async () => {
        const cur = shown(held.current);
        if (!cur) return;
        const elapsed = Math.floor(activeMs(cur, Date.now()) / 1000);
        // Once the plan is used up, "+5" means five more minutes from now, not from the end.
        const from = Math.max(cur.plannedSeconds, elapsed);
        const next = Math.min(PLANNED_SECONDS.max, Math.max(PLANNED_SECONDS.min, from + deltaSeconds));
        // At the longest plan the server takes, + has nothing left to add (and must not finish).
        if (deltaSeconds > 0 && next <= from) return;
        if (next <= elapsed) {
          // Shrinking below what's already elapsed means "I'm done now".
          const session = await end(() => api.finishSession(cur.id));
          if (session.status === 'completed') setFinished(session);
          return;
        }
        await press(
          cur,
          (s) => ({ ...s, plannedSeconds: next }),
          () => api.patchSession(cur.id, { plannedSeconds: next }),
        );
      }),
    [attempt, end, press],
  );

  const setLabel = useCallback(
    (label: string) =>
      attempt(async () => {
        const cur = shown(held.current);
        if (!cur) return;
        const session = await press(
          cur,
          (s) => ({ ...s, label }),
          () => api.patchSession(cur.id, { label }),
        );
        if (session.status !== 'running') store.applySession(session);
      }),
    [attempt, press, store],
  );

  // Pause and resume hold the clock at once; the log row's pill reads the day's copy, which
  // takes the server's row when it answers.
  const setPaused = useCallback(
    (paused: boolean) =>
      attempt(async () => {
        const cur = shown(held.current);
        if (!cur || (cur.pausedAt != null) === paused) return;
        const now = Date.now();
        const apply = (s: Session): Session =>
          paused
            ? { ...s, pausedAt: s.pausedAt ?? now }
            : s.pausedAt == null
              ? s
              : { ...s, pausedAt: null, pausedSeconds: s.pausedSeconds + Math.round((now - s.pausedAt) / 1000) };
        const session = await press(cur, apply, () => (paused ? api.pauseSession(cur.id) : api.resumeSession(cur.id)));
        store.applySession(session);
      }),
    [attempt, press, store],
  );
  const pause = useCallback(() => setPaused(true), [setPaused]);
  const resume = useCallback(() => setPaused(false), [setPaused]);

  const finish = useCallback(
    (countOverrun = false) =>
      attempt(async () => {
        setFinishChoice(false);
        const cur = shown(held.current);
        if (!cur) return;
        const session = await end(() => api.finishSession(cur.id, countOverrun));
        // Finish is idempotent: a session cancelled elsewhere comes back as it is.
        if (session.status === 'completed') setFinished(session);
      }),
    [attempt, end],
  );

  const requestFinish = useCallback(() => {
    const cur = shown(held.current);
    if (!cur) return;
    const v = timerView(cur, Date.now());
    // Under a minute over, both lengths are the same whole minutes: nothing to ask.
    if (v.due && Math.floor(v.elapsedSeconds / 60) !== Math.floor(cur.plannedSeconds / 60)) setFinishChoice(true);
    else void finish();
  }, [finish]);
  const dismissFinishChoice = useCallback(() => setFinishChoice(false), []);

  const cancel = useCallback(
    () =>
      attempt(async () => {
        setFinishChoice(false);
        const cur = shown(held.current);
        if (!cur) return;
        await end(() => api.cancelSession(cur.id));
      }),
    [attempt, end],
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
      finished,
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
      finished,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTimer(): TimerCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTimer outside TimerProvider');
  return v;
}
