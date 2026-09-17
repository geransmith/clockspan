import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as api from '../api';
import type { Settings } from '../types';
import { DEFAULT_SETTINGS } from '../../../shared/settings.js';
import { normalizeLayout } from '../lib/layout';
import { useLatest } from './useLatest';

interface SettingsCtx {
  settings: Settings;
  loaded: boolean;
  update: (patch: Partial<Settings>) => Promise<void>;
  reset: () => Promise<void>;
}

const Ctx = createContext<SettingsCtx | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  // The shared defaults stand in until the server answers, so nothing renders against a guess.
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const latest = useLatest(settings);
  // Saves can overlap (two chips tapped quickly). A response only lands if nothing newer was
  // sent after it, so the first answer can't briefly undo the second optimistic change.
  const seq = useRef(0);

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
    const mine = ++seq.current;
    setSettings({ ...prev, ...patch });
    try {
      const saved = await api.putSettings(patch);
      if (seq.current === mine) setSettings({ ...saved, layout: normalizeLayout(saved.layout) });
    } catch (err) {
      // A newer save is in flight: its answer settles the state, so don't roll it back here.
      if (seq.current === mine) setSettings(prev);
      throw err;
    }
  }, [latest]);

  // Not optimistic: the server's answer is the copy of the defaults that counts.
  const reset = useCallback(async () => {
    const mine = ++seq.current;
    const saved = await api.resetSettings();
    if (seq.current === mine) setSettings({ ...saved, layout: normalizeLayout(saved.layout) });
  }, []);

  const value = useMemo(() => ({ settings, loaded, update, reset }), [settings, loaded, update, reset]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSettings(): SettingsCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSettings outside SettingsProvider');
  return v;
}
