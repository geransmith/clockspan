import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as api from '../api';
import { nextBackoff } from '../../../shared/backoff.js';
import { pausedSecondsAfter } from '../../../shared/timer.js';
import type { Session, SessionConflict } from '../types';
import { alert, dismissByTag, unlockAudio, warnQuietly } from '../lib/alerts';
import { ApiError } from '../lib/apiError';
import { SAVE_FAILED, TIMER_DONE, TIMER_DUE, TIMER_ELSEWHERE, TIMER_PAUSED_OUT } from '../lib/copy';
import { formatCountdown, formatDuration } from '../lib/format';
import { addPending, fetched, settle, settleWith, shown, untracked, type Tracked } from '../lib/optimistic';
import { readStored, writeStored } from '../lib/storage';
import { adjustedPlan, DUE_GRACE_SECONDS, dueKey, PAUSE_LIMIT_SECONDS, timerView, type TimerView } from '../lib/timer';
import { useDayStore } from './useDay';
import { useClock } from './useClock';
import { useRefreshLoop } from './useRefreshLoop';
import { useSettings } from './useSettings';
import { useTracked } from './useTracked';
import { useWakeLock } from './useWakeLock';

interface TimerCtx {
  running: Session | null;
  /** Seconds left; below zero once due. Derived from the server's startedAt and pauses every tick. */
  countdownSeconds: number;
  elapsedSeconds: number;
  /** 0..1 */
  progress: number;
  paused: boolean;
  /** The planned time is used up; the session waits for more time or a finish. */
  due: boolean;
  overrunSeconds: number;
  start: (date: string, plannedSeconds: number, label: string, priorityUid?: string | null) => Promise<void>;
  /** Mid-session, ± the planned length; once due, +N is N more minutes from now. Plans are whole minutes. */
  adjust: (deltaSeconds: number) => Promise<void>;
  /** + has something to add: false once the plan (or the time worked) is at the longest the server takes. */
  canAdd: boolean;
  /**
   * Renames the running session or links it to another priority. The bar and the log's running
   * row both edit through here, so the session's writes share one queue and both show the edit.
   */
  edit: (patch: api.SessionEdit) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  /** `countOverrun` logs the time past the planned end too; otherwise a late finish logs the plan. */
  finish: (countOverrun?: boolean) => Promise<void>;
  /**
   * The Finish button: finishes now, unless the timer ran out and the planned and the worked
   * length differ in their whole minutes, where `finishChoice` asks which one to log.
   */
  requestFinish: () => void;
  /** The running session while "How much to log?" is open for it; null otherwise. */
  finishChoice: Session | null;
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
const IDLE: TimerView = {
  elapsedSeconds: 0,
  countdownSeconds: 0,
  progress: 0,
  endAt: 0,
  paused: false,
  pausedForSeconds: 0,
  due: false,
  overrunSeconds: 0,
  canAdd: false,
  asksLength: false,
};

// The last planned end that was announced, kept across reloads so the chime plays once per
// end. The page also remembers it (`announcedEnd`), so with storage blocked or full only a
// reload can chime a second time.
const DUE_STORAGE_KEY = 'focus:timer-due';

export function TimerProvider({ children }: { children: ReactNode }) {
  // The running session as the server confirmed it, plus the presses (adjust, rename, pause,
  // resume) it hasn't answered yet (`lib/optimistic.ts`); `null` confirmed is "none running".
  // Every write (a start and a finish too) goes out on `queue` once the one before it has
  // answered, so the server ends where the screen does: two +5s in flight could land swapped.
  const { tracked, current, change, nextId, queue } = useTracked<Tracked<Session | null>>(untracked);
  const running = useMemo(() => shown(tracked) ?? null, [tracked]);
  // The session "How much to log?" was asked for: once it ends, however it ends, the question
  // goes with it and never opens over the next one.
  const [finishChoiceFor, setFinishChoiceFor] = useState<number | null>(null);
  const [finished, setFinished] = useState<Session | null>(null);
  const now = useClock();
  // `loaded` gates the two effects that alert: on a fresh load the running session can answer
  // before the settings do, and an alert then would use the default sounds and Sound switch
  // (`settings.sounds`, `settings.sound`).
  const { settings, loaded } = useSettings();
  const { refresh, applySession, prioritiesSaved } = useDayStore();
  const completing = useRef(false);
  // After a failed finish (server unreachable) wait before trying again (`nextBackoff`). The
  // server clamps ended_at to the planned end, so a late finish still logs the planned
  // duration; all a wait costs is the chime's promptness.
  const retry = useRef({ at: 0, delay: 0 });
  // The planned end this page last announced (its `dueKey`). DUE_STORAGE_KEY carries it across
  // a reload; this covers the page itself when storage keeps nothing.
  const announcedEnd = useRef<string | null>(null);

  // Re-sync with the server on load, when the tab comes back, and every minute
  // (`useRefreshLoop`), and at once when a press finds the session gone (`syncNow`: a sync sent
  // after the refusal, since one already out may still show the session running; it waits for
  // that one, and the tab coming back just after asks nothing more). The answer replaces the
  // confirmed session unless the server confirmed a change after it went out, and a press still
  // on its way stays on top of it. A different session than the one shown means another device
  // started or ended a timer: its day is fetched again, quietly, if the store holds it, so the
  // log shows the row this device never wrote. A day it doesn't hold loads with the row when
  // it is opened.
  const sync = useCallback(() => {
    const sentAt = current().version;
    return api
      .getRunning()
      .then(({ session }) => {
        const held = current();
        const prev = shown(held) ?? null;
        const { next } = fetched(held, sentAt, session);
        if (next === held) return;
        change(() => next);
        if (prev?.id === session?.id) return;
        for (const date of new Set([prev?.date, session?.date])) if (date) void refresh(date);
      })
      .catch(() => {});
  }, [current, change, refresh]);
  const { runNow: syncNow } = useRefreshLoop(sync, true);

  // The session is over (finished or cancelled, here or by the server): nothing runs now, and
  // the day's log takes the row. Unless a sync has meanwhile shown a session another device
  // started: the answer is about the one before it, and the new one keeps running.
  const end = useCallback(
    async (send: () => Promise<{ session: Session }>) => {
      const { session } = await queue(send);
      change((t) => (t.confirmed && t.confirmed.id !== session.id ? t : settleWith(t, [], null)));
      applySession(session);
      return session;
    },
    [change, queue, applySession],
  );

  // A finish by hand (Finish, the finish choice, − past the time worked), which `finished`
  // reports. Finish is idempotent: a session cancelled elsewhere comes back as it is.
  const finishNow = useCallback(
    async (cur: Session, countOverrun = false) => {
      const session = await end(() => api.finishSession(cur.id, countOverrun));
      if (session.status === 'completed') setFinished(session);
    },
    [end],
  );

  const { elapsedSeconds, countdownSeconds, progress, endAt, paused, pausedForSeconds, due, overrunSeconds, canAdd } = running ? timerView(running, now) : IDLE;

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
            body: TIMER_PAUSED_OUT.body(session.label, formatDuration(done.durationSeconds)),
            tone: 'info',
            tag: 'timer-complete',
            sound: false,
            notifications: false,
          });
          return;
        }
        // The chime played when the end came, unless the page was closed then.
        const key = dueKey(session.id, endAt);
        const chimed = announcedEnd.current === key || readStored(DUE_STORAGE_KEY) === key;
        alert({
          title: TIMER_DONE.title,
          body: TIMER_DONE.body(session.label, formatDuration(done.durationSeconds)),
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
      ? `${paused ? 'Paused ' : ''}${formatCountdown(countdownSeconds)}${running.label ? ` · ${running.label}` : ''} — ${BASE_TITLE}`
      : BASE_TITLE;
    // The error card unmounts the provider without a page load; the tab shouldn't keep a
    // frozen countdown.
    return () => {
      document.title = BASE_TITLE;
    };
  }, [running, countdownSeconds, paused]);

  const start = useCallback(
    async (date: string, plannedSeconds: number, label: string, priorityUid: string | null = null) => {
      unlockAudio(); // user gesture: lets the completion chime play later on iOS
      try {
        const { session } = await queue(async () => {
          // A chip can link a row whose priorities save is still out.
          if (priorityUid) await prioritiesSaved(date);
          return api.startSession(date, plannedSeconds, label, priorityUid);
        });
        change((t) => settleWith(t, [], session));
        applySession(session);
      } catch (err) {
        const theirs = err instanceof ApiError && err.status === 409 ? (err.body as Partial<SessionConflict> | null)?.session : undefined;
        if (!theirs) throw err;
        // 409: a timer is already running, started on another device. Follow it, fetch its
        // day again if the store holds it so the log has the row, and say why what was typed
        // here went nowhere.
        change((t) => settleWith(t, [], theirs));
        void refresh(theirs.date);
        alert({ ...TIMER_ELSEWHERE, tone: 'info', tag: 'timer-elsewhere', sound: false, notifications: false });
      }
    },
    [change, queue, applySession, refresh, prioritiesSaved],
  );

  // The bar and the card call these with `void`, so a failure has to be reported here: the
  // running state is what the server last confirmed, and the banner says the press was lost.
  // A press acts on the session shown now, and does nothing when none is.
  const attempt = useCallback(
    async (run: (cur: Session) => Promise<void>) => {
      const cur = shown(current());
      if (!cur) return;
      try {
        await run(cur);
      } catch (err) {
        warnQuietly({ ...SAVE_FAILED, tag: 'save-failed' });
        // Gone, or no longer running: it ended on another device. Show that now, not at the
        // next poll.
        if (err instanceof ApiError && (err.status === 404 || err.status === 409)) void syncNow();
      }
    },
    [current, syncNow],
  );

  // A press on the running session (adjust, edit, pause, resume): shown at once, sent after
  // the writes before it, and the server's row taken by the timer and the day's log when it
  // answers. A failure just drops the change, so the screen is back on the stored row with any
  // later press still on top. A row that answers as no longer running ended elsewhere: nothing
  // runs here either. If a sync already showed this session ended (and maybe another started)
  // while the press waited, the answer only says what became of this row: the timer keeps what
  // the sync showed, and a running answer is older than the sync, so the log doesn't take it.
  const press = useCallback(
    async (cur: Session, apply: (s: Session) => Session, send: () => Promise<{ session: Session }>) => {
      const id = nextId();
      change((t) => addPending(t, id, (s) => (s && s.id === cur.id ? apply(s) : s)));
      try {
        const { session } = await queue(send);
        const same = current().confirmed?.id === cur.id;
        change((t) => (same ? settleWith(t, [id], session.status === 'running' ? session : null) : settle(t, [id])));
        if (same || session.status !== 'running') applySession(session);
      } catch (err) {
        change((t) => settle(t, [id]));
        throw err;
      }
    },
    [current, change, nextId, queue, applySession],
  );

  const adjust = useCallback(
    (deltaSeconds: number) =>
      attempt(async (cur) => {
        const plan = adjustedPlan(cur, Date.now(), deltaSeconds);
        if (plan === null) return;
        if (plan === 'finish') {
          await finishNow(cur);
          return;
        }
        await press(
          cur,
          (s) => ({ ...s, plannedSeconds: plan }),
          () => api.patchSession(cur.id, { plannedSeconds: plan }),
        );
      }),
    [attempt, finishNow, press],
  );

  const edit = useCallback(
    (patch: api.SessionEdit) =>
      attempt((cur) =>
        press(
          cur,
          (s) => ({ ...s, ...patch }),
          async () => {
            if (patch.priorityUid) await prioritiesSaved(cur.date);
            return api.patchSession(cur.id, patch);
          },
        ),
      ),
    [attempt, press, prioritiesSaved],
  );

  const setPaused = useCallback(
    (paused: boolean) =>
      attempt(async (cur) => {
        if ((cur.pausedAt != null) === paused) return;
        const now = Date.now();
        const apply = (s: Session): Session =>
          paused ? { ...s, pausedAt: s.pausedAt ?? now } : { ...s, pausedAt: null, pausedSeconds: pausedSecondsAfter(s, now) };
        await press(cur, apply, () => (paused ? api.pauseSession(cur.id) : api.resumeSession(cur.id)));
      }),
    [attempt, press],
  );
  const pause = useCallback(() => setPaused(true), [setPaused]);
  const resume = useCallback(() => setPaused(false), [setPaused]);

  const finish = useCallback(
    (countOverrun = false) =>
      attempt(async (cur) => {
        setFinishChoiceFor(null);
        await finishNow(cur, countOverrun);
      }),
    [attempt, finishNow],
  );

  const requestFinish = useCallback(() => {
    const cur = shown(current());
    if (!cur) return;
    if (timerView(cur, Date.now()).asksLength) setFinishChoiceFor(cur.id);
    else void finish();
  }, [current, finish]);
  const dismissFinishChoice = useCallback(() => setFinishChoiceFor(null), []);

  const cancel = useCallback(
    () =>
      attempt(async (cur) => {
        await end(() => api.cancelSession(cur.id));
      }),
    [attempt, end],
  );

  // Time's up: announce once per (session, planned end) and leave the session open for an
  // answer. The chime plays once per end (`announcedEnd`, and DUE_STORAGE_KEY across a reload,
  // which shows the banner again without it); adding time moves the end and re-arms. The
  // banner goes while the timer is not due: finished, given time, cancelled, ended on another
  // device, or a press still on its way. A press that fails brings the same end back, and with
  // it the banner, quietly.
  const announced = useRef<string | null>(null);
  const step = settings.adjustStepMinutes;
  useEffect(() => {
    if (!running || !due) {
      dismissByTag('timer-due');
      announced.current = null;
      return;
    }
    if (!loaded || overrunSeconds >= DUE_GRACE_SECONDS) return;
    const key = dueKey(running.id, endAt);
    // Raised again, quietly, when the time worked reaches the longest plan: + has nothing left
    // to add, and a button that does nothing must not stay up.
    const raised = `${key}:${canAdd}`;
    if (announced.current === raised) return;
    announced.current = raised;
    const fresh = announcedEnd.current !== key && readStored(DUE_STORAGE_KEY) !== key;
    announcedEnd.current = key;
    writeStored(DUE_STORAGE_KEY, key);
    alert({
      title: TIMER_DUE.title,
      body: TIMER_DUE.body(running.label, formatDuration(running.plannedSeconds)),
      tone: 'info',
      sticky: true,
      chime: settings.sounds.timer,
      tag: 'timer-due',
      action: canAdd ? { label: TIMER_DUE.more(step), run: () => void adjust(step * 60) } : undefined,
      sound: fresh && settings.sound,
      notifications: fresh && settings.notifications,
    });
  }, [running, loaded, due, overrunSeconds, endAt, canAdd, step, adjust, settings.sound, settings.sounds.timer, settings.notifications]);

  const value = useMemo(
    () => ({
      running,
      countdownSeconds,
      elapsedSeconds,
      progress,
      paused,
      due,
      overrunSeconds,
      start,
      adjust,
      canAdd,
      edit,
      pause,
      resume,
      finish,
      requestFinish,
      finishChoice: running != null && finishChoiceFor === running.id ? running : null,
      dismissFinishChoice,
      cancel,
      finished,
    }),
    [
      running,
      countdownSeconds,
      elapsedSeconds,
      progress,
      paused,
      due,
      overrunSeconds,
      start,
      adjust,
      canAdd,
      edit,
      pause,
      resume,
      finish,
      requestFinish,
      finishChoiceFor,
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
