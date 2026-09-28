import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { alert, dismissByTag } from '../lib/alerts';
import { BREAK } from '../lib/copy';
import { readStoredJson, writeStored } from '../lib/storage';
import { useNow } from './useNow';
import { useSettings } from './useSettings';

interface BreakCtx {
  /** When the break ends; null when there is none. */
  endsAt: number | null;
  remainingSeconds: number;
  /** A break of `settings.breakMinutes` from now. */
  start: () => void;
  /** Back early (or a focus timer started): no alert. */
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
 * would ring with the default sound.
 */
export function BreakProvider({ children }: { children: ReactNode }) {
  const { settings, loaded } = useSettings();
  const [endsAt, setEndsAt] = useState<number | null>(storedEnd);
  const now = useNow(1000);
  // A break that has run out reads as none straight away; the effect below announces it once.
  const active = endsAt != null && now < endsAt ? endsAt : null;
  const announced = useRef<number | null>(null);

  const save = useCallback((next: number | null) => {
    writeStored(STORAGE_KEY, JSON.stringify({ endsAt: next }));
    setEndsAt(next);
  }, []);

  const start = useCallback(() => {
    dismissByTag('break');
    save(Date.now() + settings.breakMinutes * 60_000);
  }, [save, settings.breakMinutes]);
  const end = useCallback(() => save(null), [save]);

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
  const value = useMemo(() => ({ endsAt: active, remainingSeconds, start, end }), [active, remainingSeconds, start, end]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBreak(): BreakCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useBreak outside BreakProvider');
  return v;
}
