import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { alert, dismissByTag, unlockAudio } from '../lib/alerts';
import { runningBreak, SET_SIZE, suggestBreak } from '../lib/breaks';
import { BREAK, BREAK_SUGGESTION } from '../lib/copy';
import { addDays, MINUTE_MS, todayKey } from '../../../shared/dates.js';
import { formatDuration } from '../lib/format';
import { readStored, USER_KEYS, writeStored } from '../lib/storage';
import { useDays, useDayStore } from './useDay';
import { useLatest } from './useLatest';
import { useClock } from './useClock';
import { useSettings } from './useSettings';
import { useTimer } from './useTimer';

interface BreakCtx {
  /** When the running break ends (today's, or one started before midnight); null when there is none. */
  endsAt: number | null;
  remainingSeconds: number;
  /**
   * What the Break button offers: with Suggest breaks on, the break today's latest session
   * earned (`suggestBreak`); otherwise, or before a session is logged, `settings.breakMinutes`.
   */
  next: { minutes: number; long: boolean };
  /** A break of `minutes` from now, logged on today's sheet. Call it from a tap: it unlocks audio for the Break over sound. */
  start: (minutes: number) => void;
  /** Back early: the break ends now without an alert (dropped if it ran under a minute), and a suggestion still up goes. */
  end: () => void;
}

const Ctx = createContext<BreakCtx | null>(null);

/**
 * When the last break whose end was dealt with (announced, or found ended early or long ago)
 * started, so a reload doesn't ring it again. Keyed by the start, not the id: SQLite gives a new
 * break the id of a deleted newest one, and a user's breaks never overlap, so one that started
 * later is new and one that started earlier (last again after a later one was deleted) is done.
 */
const OVER_KEY = USER_KEYS.breakOver;

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
  const { days } = useDays();
  const { startBreak, endBreak } = useDayStore();
  const now = useClock();
  const date = todayKey(now);
  const today = days[date];
  // A break started before midnight stays on the day it started, which the store still has (it
  // was today's sheet), so it keeps counting down, can be ended and rings after midnight. Only
  // until something starts today: the server ended it then, and `applySession` ends it in the
  // store too, so a session cancelled afterwards doesn't bring it back.
  const breaks = (today?.breaks.length || today?.sessions.length ? today : days[addDays(date, -1)])?.breaks ?? [];
  const current = runningBreak(breaks, now);
  // The start of the last break dealt with here (see OVER_KEY).
  const dealtWith = useRef(0);

  // A start is out: a second tap before it answers would log a second break that ends the first at once.
  const starting = useRef(false);
  const start = useCallback(
    (minutes: number) => {
      unlockAudio(); // a tap: lets the Break over sound play later on iOS
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
    if (current) void endBreak(current.date, current.id);
  }, [endBreak, current]);

  // A timer running means the break is over (the server ended it as the session started), and
  // so is any banner about breaks: a suggestion or Break's over.
  const working = running != null;
  useEffect(() => {
    if (working) dismissByTag('break');
  }, [working]);

  const todaySessions = today?.sessions;
  const suggestion = useMemo(() => (settings.suggestBreaks && todaySessions ? suggestBreak(todaySessions) : null), [settings.suggestBreaks, todaySessions]);
  const next = useMemo(() => suggestion ?? { minutes: settings.breakMinutes, long: false }, [suggestion, settings.breakMinutes]);

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
        run: () => start(earned.minutes),
      },
      sound: false,
      notifications: false,
    });
  }, [finished, latest, start]);

  // Dealt with once per break, when it ends: a break that ran its full length is announced
  // (also on a load inside STALE_MS of the end, the page having been closed then). One that
  // ended early was ended by hand or by a focus timer starting, so there is nothing to say.
  const last = breaks.at(-1);
  useEffect(() => {
    if (!last || !loaded || now < last.endedAt || last.startedAt <= dealtWith.current) return;
    dealtWith.current = last.startedAt;
    // Nothing stored reads as 0, and anything unreadable as NaN: both let the break through.
    if (Number(readStored(OVER_KEY)) >= last.startedAt) return;
    writeStored(OVER_KEY, String(last.startedAt));
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
