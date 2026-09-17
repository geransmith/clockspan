import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as api from '../api';
import type { Settings } from '../types';
import { normalizeLayout } from '../lib/layout';

interface SettingsCtx {
  settings: Settings;
  loaded: boolean;
  update: (patch: Partial<Settings>) => Promise<void>;
  reset: () => Promise<void>;
}

/** Client-side mirror of the server defaults; replaced by the real settings on load. */
const FALLBACK: Settings = {
  workMinutes: 480,
  lunchDeadlineMinutes: 300,
  lunchMinutes: 30,
  secondMealAfterMinutes: 600,
  adjustStepMinutes: 5,
  priorityCount: 3,
  sound: true,
  notifications: true,
  keepScreenAwake: true,
  overtimeApproval: true,
  alarms: {
    lunchBy: { enabled: true, leadMinutes: [15, 5, 1], onDue: true, overdueEveryMinutes: 5 },
    clockOut: { enabled: true, leadMinutes: [15, 5, 1], onDue: true, overdueEveryMinutes: 5 },
    secondMeal: { enabled: true, leadMinutes: [15, 5, 1], onDue: true, overdueEveryMinutes: 5 },
    retro: { enabled: true, leadMinutes: [30], onDue: false, overdueEveryMinutes: 0 },
  },
  layout: normalizeLayout(undefined),
  retention: { enabled: false, days: 365 },
};

const Ctx = createContext<SettingsCtx | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(FALLBACK);
  const [loaded, setLoaded] = useState(false);
  const latest = useRef(settings);
  latest.current = settings;

  useEffect(() => {
    let cancelled = false;
    api
      .getSettings()
      .then((s) => {
        if (cancelled) return;
        setSettings({ ...s, layout: normalizeLayout(s.layout) });
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback(async (patch: Partial<Settings>) => {
    const prev = latest.current;
    setSettings({ ...prev, ...patch });
    try {
      const saved = await api.putSettings(patch);
      setSettings({ ...saved, layout: normalizeLayout(saved.layout) });
    } catch (err) {
      setSettings(prev);
      throw err;
    }
  }, []);

  // Not optimistic: the client's FALLBACK is only a mirror, so the server's answer is the
  // first trustworthy copy of the defaults.
  const reset = useCallback(async () => {
    const saved = await api.resetSettings();
    setSettings({ ...saved, layout: normalizeLayout(saved.layout) });
  }, []);

  const value = useMemo(() => ({ settings, loaded, update, reset }), [settings, loaded, update, reset]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSettings(): SettingsCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSettings outside SettingsProvider');
  return v;
}
