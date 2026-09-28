import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { alert, dismissByTag, unlockAudio } from '../lib/alerts';
import { SET_SIZE, suggestBreak } from '../lib/breaks';
import { BREAK, BREAK_SUGGESTION } from '../lib/copy';
import { formatDuration, todayKey } from '../lib/format';
import { readStoredJson, writeStored } from '../lib/storage';
import { useDayStore } from './useDay';
import { useLatest } from './useLatest';
import { useNow } from './useNow';
import { useSettings } from './useSettings';
import { useTimer } from './useTimer';

interface BreakCtx {
  /** When the break ends; null when there is none. */
  endsAt: number | null;
  remainingSeconds: number;
  /**
   * What the Break button offers: with Suggest breaks on, the break today's latest session
   * earned (`suggestBreak`); otherwise, or before a session is logged, `settings.breakMinutes`.
   */
  next: { minutes: number; long: boolean };
  /** A break of `minutes` from now. */
  start: (minutes: number) => void;
  /** Back early (or a focus timer started): no alert, and a suggestion still up goes. */
  end: () => void;
}

const Ctx = createContext<BreakCtx | null>(null);

/** Kept on this device only, so a reload mid-break keeps it; a break is not logged anywhere. */
const STORAGE_KEY = 'focus:break';

/** An end older than this is from another sitting (the tab was closed): it is dropped, not announced. */
const STALE_MS = 10 * 60_000;

function storedEnd(): number | null {
  const v = readStoredJson(STORAGE_KEY);
  return v && typeof v === 'object' && typeof (v as { endsAt?: unknown }).endsAt === 'number' ? (v as { endsAt: number }).endsAt : null;
}

/**
 * A short break after a focus session: a countdown with nothing logged, and a banner (with the
 * Break over sound) when it runs out. Like the timer's alerts it waits for the settings, or it
 * would ring with the default sound. With Suggest breaks on, a session finished by hand raises
 * a banner offering the break it earned; it is quiet, since the user just pressed Finish.
 */
export function BreakProvider({ children }: { children: ReactNode }) {
  const { settings, loaded } = useSettings();
  const { finished } = useTimer();
  const { days } = useDayStore();
  const [endsAt, setEndsAt] = useState<number | null>(storedEnd);
  const now = useNow(1000);
  // A break that has run out reads as none straight away; the effect below announces it once.
  const active = endsAt != null && now < endsAt ? endsAt : null;
  const announced = useRef<number | null>(null);

  const save = useCallback((next: number | null) => {
    writeStored(STORAGE_KEY, JSON.stringify({ endsAt: next }));
    setEndsAt(next);
  }, []);

  const start = useCallback(
    (minutes: number) => {
      dismissByTag('break');
      save(Date.now() + minutes * 60_000);
    },
    [save],
  );
  const end = useCallback(() => {
    dismissByTag('break');
    save(null);
  }, [save]);

  const todaySessions = days[todayKey(now)]?.sessions;
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

  useEffect(() => {
    if (endsAt == null || !loaded || now < endsAt || announced.current === endsAt) return;
    announced.current = endsAt;
    // Forgotten here too, so a reload doesn't announce it again.
    writeStored(STORAGE_KEY, JSON.stringify({ endsAt: null }));
    if (now - endsAt > STALE_MS) return;
    alert({
      title: BREAK.over,
      body: BREAK.overBody,
      tone: 'info',
      chime: settings.sounds.breakDone,
      tag: 'break',
      sound: settings.sound,
      notifications: settings.notifications,
    });
  }, [endsAt, loaded, now, settings.sound, settings.sounds.breakDone, settings.notifications]);

  const remainingSeconds = active == null ? 0 : Math.ceil((active - now) / 1000);
  const value = useMemo(() => ({ endsAt: active, remainingSeconds, next, start, end }), [active, remainingSeconds, next, start, end]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBreak(): BreakCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useBreak outside BreakProvider');
  return v;
}
