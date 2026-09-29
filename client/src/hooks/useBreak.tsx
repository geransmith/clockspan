import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { alert, dismissByTag, unlockAudio } from '../lib/alerts';
import { runningBreak, SET_SIZE, suggestBreak } from '../lib/breaks';
import { BREAK, BREAK_SUGGESTION } from '../lib/copy';
import { MINUTE_MS, todayKey } from '../../../shared/dates.js';
import { formatDuration } from '../lib/format';
import { readStored, writeStored } from '../lib/storage';
import { useDayStore } from './useDay';
import { useLatest } from './useLatest';
import { useNow } from './useNow';
import { useSettings } from './useSettings';
import { useTimer } from './useTimer';

interface BreakCtx {
  /** When today's running break ends; null when there is none. */
  endsAt: number | null;
  remainingSeconds: number;
  /**
   * What the Break button offers: with Suggest breaks on, the break today's latest session
   * earned (`suggestBreak`); otherwise, or before a session is logged, `settings.breakMinutes`.
   */
  next: { minutes: number; long: boolean };
  /** A break of `minutes` from now, logged on today's sheet. */
  start: (minutes: number) => void;
  /** Back early: the break ends now without an alert (dropped if it ran under a minute), and a suggestion still up goes. */
  end: () => void;
}

const Ctx = createContext<BreakCtx | null>(null);

/** The last break whose end was dealt with (announced, or found ended early or long ago), so a reload doesn't ring it again. */
const OVER_KEY = 'focus:break-over';

/** An end older than this is from another sitting (the tab was closed): it is dropped, not announced. */
const STALE_MS = 10 * MINUTE_MS;

/**
 * Breaks between focus sessions. A break is a row in today's log (`Day.breaks`), so it counts
 * down on every device and survives a reload; this provider reads the running one from the
 * day, starts and ends them through the day store, and raises the banner (with the Break over
 * sound) when one runs its full length. Like the timer's alerts it waits for the settings, or
 * it would ring with the default sound. With Suggest breaks on, a session finished by hand
 * raises a banner offering the break it earned; it is quiet, since the user just pressed
 * Finish.
 */
export function BreakProvider({ children }: { children: ReactNode }) {
  const { settings, loaded } = useSettings();
  const { finished, running } = useTimer();
  const { days, startBreak, endBreak } = useDayStore();
  const now = useNow(1000);
  const today = days[todayKey(now)];
  const breaks = today?.breaks;
  const current = breaks ? runningBreak(breaks, now) : null;
  const latestCurrent = useLatest(current);
  const announced = useRef<number | null>(null);

  // A start is out: a second tap before it answers would log a second break that ends the first at once.
  const starting = useRef(false);
  const start = useCallback(
    (minutes: number) => {
      if (starting.current) return;
      starting.current = true;
      dismissByTag('break');
      void startBreak(todayKey(Date.now()), minutes * 60).finally(() => {
        starting.current = false;
      });
    },
    [startBreak],
  );
  const end = useCallback(() => {
    dismissByTag('break');
    const b = latestCurrent.current;
    if (b) void endBreak(b.date, b.id);
  }, [endBreak, latestCurrent]);

  // A timer running means the break is over (the server ended it as the session started), and
  // so is any banner about breaks: a suggestion or Break's over.
  const working = running != null;
  useEffect(() => {
    if (working) dismissByTag('break');
  }, [working]);

  const todaySessions = today?.sessions;
  const suggestion = useMemo(() => (settings.suggestBreaks && todaySessions ? suggestBreak(todaySessions) : null), [settings.suggestBreaks, todaySessions]);
  const breakMinutes = settings.breakMinutes;
  const next = useMemo(() => suggestion ?? { minutes: breakMinutes, long: false }, [suggestion, breakMinutes]);

  // Read once a session is finished by hand: applySession put the row on today's sheet in the
  // same render, so today's suggestion is the one it earned, and the banner and the Break button
  // agree. None with the setting off, for a false start, or for a session that ran past midnight
  // (it is on yesterday's sheet, so today's suggestion isn't about it).
  const latest = useLatest(suggestion);
  useEffect(() => {
    const earned = latest.current;
    if (!finished || !earned || earned.sessionId !== finished.id) return;
    alert({
      kicker: BREAK_SUGGESTION.kicker(earned.position, SET_SIZE),
      title: BREAK_SUGGESTION.title(earned.minutes, earned.long),
      body: BREAK_SUGGESTION.body(formatDuration(earned.focusSeconds), earned.long, SET_SIZE),
      tone: 'info',
      sticky: true,
      tag: 'break',
      action: {
        label: BREAK_SUGGESTION.start,
        run: () => {
          // A gesture, so iOS lets the Break over sound play later.
          unlockAudio();
          start(earned.minutes);
        },
      },
      sound: false,
      notifications: false,
    });
  }, [finished, latest, start]);

  // Dealt with once per break, when it ends: a break that ran its full length is announced
  // (also on a load inside STALE_MS of the end, the page having been closed then). One that
  // ended early was ended by hand or by a focus timer starting, so there is nothing to say.
  const last = breaks?.at(-1);
  useEffect(() => {
    if (!last || !loaded || now < last.endedAt || announced.current === last.id) return;
    announced.current = last.id;
    const key = String(last.id);
    if (readStored(OVER_KEY) === key) return;
    writeStored(OVER_KEY, key);
    if (last.endedAt < last.startedAt + last.plannedSeconds * 1000 || now - last.endedAt > STALE_MS) return;
    alert({
      title: BREAK.over,
      body: BREAK.overBody,
      tone: 'info',
      chime: settings.sounds.breakDone,
      tag: 'break',
      sound: settings.sound,
      notifications: settings.notifications,
    });
  }, [last, loaded, now, settings.sound, settings.sounds.breakDone, settings.notifications]);

  const endsAt = current?.endedAt ?? null;
  const remainingSeconds = endsAt == null ? 0 : Math.ceil((endsAt - now) / 1000);
  const value = useMemo(() => ({ endsAt, remainingSeconds, next, start, end }), [endsAt, remainingSeconds, next, start, end]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBreak(): BreakCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useBreak outside BreakProvider');
  return v;
}
