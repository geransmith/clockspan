import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as api from '../api';
import { nextBackoff } from '../../../shared/backoff.js';
import { pausedSecondsAfter } from '../../../shared/timer.js';
import type { Session, SessionResponse } from '../types';
import { alert, dismissByTag, warnSaveFailed } from '../lib/alerts';
import { ApiError } from '../lib/apiError';
import { TIMER_DONE, TIMER_DUE, TIMER_ELSEWHERE, TIMER_PAUSED_OUT } from '../lib/copy';
import { formatCountdown, formatDuration } from '../lib/format';
import { addPending, fetched, settle, settleWith, shown, untracked, type Tracked } from '../lib/optimistic';
import { patchRow } from '../lib/priorities';
import { editedSession, sessionName, sessionRow } from '../lib/retro';
import { readStored, writeStored } from '../lib/storage';
import { adjustedPlan, DUE_GRACE_SECONDS, dueKey, PAUSE_LIMIT_SECONDS, timerView, type TimerView } from '../lib/timer';
import type { Moment } from './useCelebration';
import { useDays, useDayStore } from './useDay';
import { useClock } from './useClock';
import { useRefreshLoop } from './useRefreshLoop';
import { useSettings } from './useSettings';
import { useTracked } from './useTracked';
import { useWakeLock } from './useWakeLock';

export interface TimerCtx extends Pick<TimerView, 'countdownSeconds' | 'elapsedSeconds' | 'progress' | 'paused' | 'due' | 'overrunSeconds' | 'canAdd'> {
  running: Session | null;
  /**
   * What the running session is called (`sessionName`): its task's current name, else its label;
   * '' while none runs. The bar, the timer card, the tab title and the timer's alerts all name it
   * by this.
   */
  name: string;
  /** The running session has a task, which names it: it has no name of its own to edit until it is set to Unplanned. */
  linked: boolean;
  /** The running session's task has an open row on the session's day, so Done can tick it. */
  taskOpen: boolean;
  /**
   * Leaves `unlockAudio()` to the caller, in its tap (`TimerLengths`). `priorityUid` may be a
   * promise, awaited first on the queue: the uid of a row whose save is still out (a new name typed
   * on the timer card, a board item's pull), so the start is out from the tap on. Its failure is
   * the start's.
   */
  start: (date: string, plannedSeconds: number, label: string, priorityUid?: string | null | Promise<string | null>) => Promise<void>;
  /**
   * A start is out, from the call to its answer, the save it waits for included: the length and
   * break buttons hold meanwhile, on the sheet and the board, since a second start would meet the
   * first as a 409, which reads as a timer started on another device.
   */
  starting: boolean;
  /** Mid-session, ± the planned length; once due, +N is N more minutes from now. Plans are whole minutes. */
  adjust: (deltaSeconds: number) => Promise<void>;
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
  /**
   * The Done button: Finish's finish, the question included, and once the server answers the
   * session completed, its task ticked and `ticked` raised from `at`. Leaves `unlockAudio()` to
   * the tap.
   */
  requestDone: (at: DOMRect) => void;
  /** The running session while "How much to log?" is open for it; null otherwise. */
  finishChoice: Session | null;
  dismissFinishChoice: () => void;
  cancel: () => Promise<void>;
  /**
   * The session last finished by hand on this device (Finish, Done, the finish choice, or − past
   * the time worked), a fresh object each time. Not one that finished on its own after the grace
   * or a forgotten pause, or on another device: its user wasn't here to take a break after it.
   */
  finished: Session | null;
  /**
   * The last task Done ticked on this device, a fresh moment each time. App celebrates it, since
   * the bar and the card Done is pressed on go with the session.
   */
  ticked: Moment | null;
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

// The last planned end (its `dueKey`) that was announced, kept across reloads so the chime
// plays once per end. The page also remembers it (`chimedEnd`), so with storage blocked or full
// only a reload can chime a second time.
const DUE_STORAGE_KEY = 'focus:timer-due';

/** Whether the chime already played for this planned end, on this page or before a reload. */
function chimedFor(chimedEnd: string | null, key: string): boolean {
  return chimedEnd === key || readStored(DUE_STORAGE_KEY) === key;
}

export function TimerProvider({ children }: { children: ReactNode }) {
  // The running session as the server confirmed it, plus the presses (adjust, rename, pause,
  // resume) it hasn't answered yet (`lib/optimistic.ts`); `null` confirmed is "none running".
  // Every write (a start and a finish too) goes out on `queue` once the one before it has
  // answered, so the server ends where the screen does: two +5s in flight could land swapped.
  const { tracked, current, change, nextId, queue } = useTracked<Tracked<Session | null>>(untracked);
  const running = useMemo(() => shown(tracked) ?? null, [tracked]);
  // The planned end "How much to log?" was asked for (its `dueKey`). The question holds only
  // while the running session is due at that end: once the session ends, however it ends, or
  // its end moves (time added, a pause), it closes and never opens over the next one.
  const [finishChoiceFor, setFinishChoiceFor] = useState<string | null>(null);
  const [finished, setFinished] = useState<Session | null>(null);
  const [ticked, setTicked] = useState<Moment | null>(null);
  // Where Done was pressed, while the finish it asked for (at once, or once the question is
  // answered) is still to come.
  const doneAt = useRef<Moment | null>(null);
  const [startsOut, setStartsOut] = useState(0);
  const now = useClock();
  // `loaded` gates the two effects that alert: on a fresh load the running session can answer
  // before the settings do, and an alert then would use the default sounds and Sound switch
  // (`settings.sounds`, `settings.sound`).
  const { settings, loaded } = useSettings();
  const { refresh, applySession, prioritiesSaved, editPriorities } = useDayStore();
  // On a day the store doesn't hold (a session started before midnight, after a reload), the name the server gave.
  const { days } = useDays();
  const rows = running ? (days[running.date]?.priorities ?? []) : [];
  const name = running ? sessionName(running, rows) : '';
  const linked = running?.priorityUid != null;
  const taskOpen = running != null && sessionRow(running, rows)?.done === false;
  // An end (a finish or a cancel, by hand or not) is out: the auto-finish waits for its answer.
  const completing = useRef(false);
  // After a failed finish (server unreachable) wait before trying again (`nextBackoff`). The
  // server clamps ended_at to the planned end, so a late finish still logs the planned
  // duration; all a wait costs is the chime's promptness.
  const retry = useRef({ at: 0, delay: 0 });
  // The planned end this page last chimed for (`chimedFor`).
  const chimedEnd = useRef<string | null>(null);

  // Re-sync with the server on load, when the tab comes back, and every minute
  // (`useRefreshLoop`), and at once on CHANGED_ELSEWHERE: another tab's or device's save, or a
  // write of this page refused as gone or changed (a press on a session ended elsewhere), sent
  // after any sync already out, which may still show the session running. The answer replaces the
  // confirmed session unless an answer with a higher revision has landed, and a press still on
  // its way stays on top of it. A different session than the one shown means another device
  // started or ended a timer: its day is fetched again, quietly, if the store holds it, so the
  // log shows the row this device never wrote. A day it doesn't hold loads with the row when
  // it is opened.
  const sync = useCallback(() => {
    return api
      .getRunning()
      .then(({ value: { session }, revision }) => {
        const held = current();
        const prev = shown(held) ?? null;
        const { next } = fetched(held, session, revision);
        if (next === held) return;
        change(() => next);
        if (prev?.id === session?.id) return;
        for (const date of new Set([prev?.date, session?.date])) if (date) void refresh(date);
      })
      .catch(() => {});
  }, [current, change, refresh]);
  // `syncing`: the tab came back and the sync it sent hasn't answered, so the copy shown may be
  // hours old. The auto-finish and the time's-up banner wait for it, as the alarms do.
  const { pending: syncing } = useRefreshLoop(sync, true);

  // The session is over (finished or cancelled, here or by the server): nothing runs now, and
  // the day's log takes the row. Unless a sync has meanwhile shown a session another device
  // started: the answer is about the one before it, and the new one keeps running.
  const end = useCallback(
    async (send: () => Promise<api.Answer<SessionResponse>>) => {
      completing.current = true;
      try {
        const {
          value: { session },
          revision,
        } = await queue(send);
        change((t) => (t.confirmed && t.confirmed.id !== session.id ? t : settleWith(t, [], null, revision)));
        applySession(session, revision);
        return session;
      } finally {
        completing.current = false;
      }
    },
    [change, queue, applySession],
  );

  // A finish by hand (Finish, Done, the finish choice, − past the time worked), which `finished`
  // reports. Finish is idempotent: a session cancelled elsewhere comes back as it is. Done's tick
  // waits for the time to be logged, so a finish that fails leaves the task open with Done there
  // to press again, and it goes to the task and day the server ended the session on.
  const finishNow = useCallback(
    async (cur: Session, countOverrun = false, done: Moment | null = null) => {
      const session = await end(() => api.finishSession(cur.id, countOverrun));
      if (session.status !== 'completed') return;
      setFinished(session);
      const uid = session.priorityUid;
      if (!done || uid == null) return;
      setTicked(done);
      void editPriorities(session.date, (rows) => patchRow(rows, uid, { done: true }));
    },
    [end, editPriorities],
  );

  const { elapsedSeconds, countdownSeconds, progress, endAt, paused, pausedForSeconds, due, overrunSeconds, canAdd } = running ? timerView(running, now) : IDLE;

  const choiceKey = running && due ? dueKey(running.id, endAt) : null;
  if (finishChoiceFor !== null && finishChoiceFor !== choiceKey) setFinishChoiceFor(null);
  const choiceOpen = choiceKey !== null && finishChoiceFor === choiceKey;

  // Completion without the user: a timer that ran out and waited DUE_GRACE_SECONDS for an
  // answer (or expired while the page was closed — the server clamps ended_at to the planned
  // end either way), or a pause left for an hour (the server ends the session where the pause
  // began, so nothing after it is logged). It sends the plan and pause it judged by, and the
  // server refuses (409) a row another device changed since: given time or resumed, it may not
  // be due any more. A row deleted there since is a 404. Either refusal brings a sync
  // (CHANGED_ELSEWHERE, api.ts) that shows what the session is now.
  useEffect(() => {
    if (!running || !loaded || syncing || completing.current || now < retry.current.at) return;
    const forgotten = pausedForSeconds >= PAUSE_LIMIT_SECONDS;
    if (!(due && overrunSeconds >= DUE_GRACE_SECONDS) && !forgotten) return;
    const session = running;
    const title = name;
    end(() => api.finishSession(session.id, false, { plannedSeconds: session.plannedSeconds, pausedAt: session.pausedAt }))
      .then((done) => {
        retry.current = { at: 0, delay: 0 };
        // Cancelled on another device before this one heard: nothing to celebrate.
        if (done.status !== 'completed') return;
        if (forgotten) {
          alert({
            title: TIMER_PAUSED_OUT.title,
            body: TIMER_PAUSED_OUT.body(title, formatDuration(done.durationSeconds)),
            tone: 'info',
            tag: 'timer-complete',
            sound: false,
            notifications: false,
          });
          return;
        }
        // The chime played when the end came, unless the page was closed then.
        const chimed = chimedFor(chimedEnd.current, dueKey(session.id, endAt));
        alert({
          title: TIMER_DONE.title,
          body: TIMER_DONE.body(title, formatDuration(done.durationSeconds)),
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
      });
  }, [running, name, loaded, syncing, now, endAt, due, overrunSeconds, pausedForSeconds, end, settings.sound, settings.sounds.timer, settings.notifications]);

  useWakeLock(running != null && !paused && !due && settings.keepScreenAwake);

  // Written only when its text changes, never reset between ticks: a reset in this effect's
  // cleanup would put "Clockspan" up between every two ticks, which a host that shows each
  // title change (the desktop app's browser pane) paints as a flicker.
  const tabTitle = running ? `${paused ? 'Paused ' : ''}${formatCountdown(countdownSeconds)}${name ? ` · ${name}` : ''} — ${BASE_TITLE}` : BASE_TITLE;
  useEffect(() => {
    document.title = tabTitle;
  }, [tabTitle]);
  // The error card unmounts the provider without a page load; the tab shouldn't keep a
  // frozen countdown.
  useEffect(() => {
    return () => {
      document.title = BASE_TITLE;
    };
  }, []);

  const start = useCallback(
    async (date: string, plannedSeconds: number, label: string, priorityUid: string | null | Promise<string | null> = null) => {
      setStartsOut((n) => n + 1);
      try {
        const {
          value: { session },
          revision,
        } = await queue(async () => {
          const uid = await priorityUid;
          // A row picked or named in the label box, or a board row's Start, can be one whose
          // priorities save is still out.
          if (uid) await prioritiesSaved(date);
          return api.startSession(date, plannedSeconds, label, uid);
        });
        change((t) => settleWith(t, [], session, revision));
        applySession(session, revision);
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 409)) throw err;
        // A timer already runs, started on another device: the sync that refusal brings shows it
        // and fetches its day again if the store holds it. This says why what was typed here went
        // nowhere.
        alert({ ...TIMER_ELSEWHERE, tone: 'info', tag: 'timer-elsewhere', sound: false, notifications: false });
      } finally {
        setStartsOut((n) => n - 1);
      }
    },
    [change, queue, applySession, prioritiesSaved],
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
      } catch {
        warnSaveFailed();
      }
    },
    [current],
  );

  // A press on the running session (adjust, edit, pause, resume): shown at once, sent after
  // the writes before it, and the server's row taken by the timer and the day's log when it
  // answers. A failure just drops the change, so the screen is back on the stored row with any
  // later press still on top. A row that answers as no longer running ended elsewhere: nothing
  // runs here either. If a sync already showed this session ended (and maybe another started)
  // while the press waited, the answer only says what became of this row: the timer keeps what
  // the sync showed, and a running answer is older than the sync, so the log doesn't take it.
  const press = useCallback(
    async (cur: Session, apply: (s: Session) => Session, send: () => Promise<api.Answer<SessionResponse>>) => {
      const id = nextId();
      change((t) => addPending(t, id, (s) => (s && s.id === cur.id ? apply(s) : s)));
      try {
        const {
          value: { session },
          revision,
        } = await queue(send);
        const same = current().confirmed?.id === cur.id;
        change((t) => (same ? settleWith(t, [id], session.status === 'running' ? session : null, revision) : settle(t, [id])));
        if (same || session.status !== 'running') applySession(session, revision);
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
          (s) => editedSession(s, patch),
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
        const done = doneAt.current;
        doneAt.current = null;
        await finishNow(cur, countOverrun, done);
      }),
    [attempt, finishNow],
  );

  const ask = useCallback(
    (done: Moment | null) => {
      const cur = shown(current());
      if (!cur) return;
      doneAt.current = done;
      const view = timerView(cur, Date.now());
      if (view.asksLength) setFinishChoiceFor(dueKey(cur.id, view.endAt));
      else void finish();
    },
    [current, finish],
  );
  // Two functions, not a flag: Finish is wired as `onClick={requestFinish}`, whose click event would pass for one.
  const requestFinish = useCallback(() => ask(null), [ask]);
  const requestDone = useCallback((at: DOMRect) => ask({ at }), [ask]);
  const dismissFinishChoice = useCallback(() => setFinishChoiceFor(null), []);

  const cancel = useCallback(
    () =>
      attempt(async (cur) => {
        await end(() => api.cancelSession(cur.id));
      }),
    [attempt, end],
  );

  // Time's up: raise the banner once per (session, planned end) and leave the session open for
  // an answer; a reload shows it again without the chime, and adding time moves the end and
  // re-arms. The banner goes while the timer is not due: finished, given time, cancelled, ended
  // on another device, or a press still on its way. A press that fails brings the same end
  // back, and with it the banner, quietly.
  const raisedBanner = useRef<string | null>(null);
  const step = settings.adjustStepMinutes;
  useEffect(() => {
    if (!running || !due) {
      dismissByTag('timer-due');
      raisedBanner.current = null;
      return;
    }
    if (!loaded || syncing || overrunSeconds >= DUE_GRACE_SECONDS) return;
    const key = dueKey(running.id, endAt);
    // Raised again, quietly, when the time worked reaches the longest plan: + has nothing left
    // to add, and a button that does nothing must not stay up. A new name doesn't raise it again:
    // a rename typed while it is up would bring a closed banner back and announce it at each
    // pause in the typing. It keeps the name it was raised with, as its notification does; the
    // bar, the card and the tab title show the new one.
    const raised = `${key}:${canAdd}`;
    if (raisedBanner.current === raised) return;
    raisedBanner.current = raised;
    const fresh = !chimedFor(chimedEnd.current, key);
    chimedEnd.current = key;
    writeStored(DUE_STORAGE_KEY, key);
    alert({
      title: TIMER_DUE.title,
      body: TIMER_DUE.body(name, formatDuration(running.plannedSeconds)),
      tone: 'info',
      sticky: true,
      chime: settings.sounds.timer,
      tag: 'timer-due',
      action: canAdd ? { label: TIMER_DUE.more(step), run: () => void adjust(step * 60) } : undefined,
      sound: fresh && settings.sound,
      notifications: fresh && settings.notifications,
    });
  }, [running, name, loaded, syncing, due, overrunSeconds, endAt, canAdd, step, adjust, settings.sound, settings.sounds.timer, settings.notifications]);

  const value = useMemo(
    () => ({
      running,
      name,
      linked,
      taskOpen,
      countdownSeconds,
      elapsedSeconds,
      progress,
      paused,
      due,
      overrunSeconds,
      start,
      starting: startsOut > 0,
      adjust,
      canAdd,
      edit,
      pause,
      resume,
      finish,
      requestFinish,
      requestDone,
      finishChoice: choiceOpen ? running : null,
      dismissFinishChoice,
      cancel,
      finished,
      ticked,
    }),
    [
      running,
      name,
      linked,
      taskOpen,
      countdownSeconds,
      elapsedSeconds,
      progress,
      paused,
      due,
      overrunSeconds,
      start,
      startsOut,
      adjust,
      canAdd,
      edit,
      pause,
      resume,
      finish,
      requestFinish,
      requestDone,
      choiceOpen,
      dismissFinishChoice,
      cancel,
      finished,
      ticked,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTimer(): TimerCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTimer outside TimerProvider');
  return v;
}
