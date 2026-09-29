import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as api from '../api';
import type { Settings } from '../types';
import { nextBackoff } from '../../../shared/backoff.js';
import { DEFAULT_SETTINGS, normalizeLayout } from '../../../shared/settings.js';
import { addPending, fetched, settle, settleWith, shown, untracked, type Tracked } from '../lib/optimistic';
import { useRefreshLoop } from './useRefreshLoop';

interface SettingsCtx {
  settings: Settings;
  loaded: boolean;
  update: (patch: Partial<Settings>) => Promise<void>;
  reset: () => Promise<void>;
}

const Ctx = createContext<SettingsCtx | null>(null);

/** The server's settings as the client keeps them: a layout this build can render. */
function fromServer(s: Settings): Settings {
  return { ...s, layout: normalizeLayout(s.layout) };
}

/**
 * The user's settings: the server's copy plus the changes not confirmed yet, like a day
 * (`lib/optimistic.ts`). A change shows at once; a save that fails leaves the server's copy
 * showing, with any later change still on top, and rejects so the dialog can say so.
 */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [tracked, setTracked] = useState<Tracked<Settings>>(untracked);
  // The same value, current at once for the callbacks below (see the day store).
  const store = useRef(tracked);
  const nextId = useRef(0);
  const change = useCallback((fn: (t: Tracked<Settings>) => Tracked<Settings>) => {
    store.current = fn(store.current);
    setTracked(store.current);
  }, []);
  // Each save goes out once the one before it has answered, failed or not: two in flight could
  // reach the server in the other order and leave it on the older value.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const inOrder = useCallback(<T,>(send: () => Promise<T>): Promise<T> => {
    const next = queue.current.catch(() => {}).then(send);
    queue.current = next;
    return next;
  }, []);

  // A read's answer. A save answered while it was out already brought all the settings, newer
  // than these (`fetched`). Settings the same as the stored copy change nothing, so `settings`
  // keeps its identity; the server builds them in one fixed order (`mergeSettings`), so equal
  // settings print the same.
  const land = useCallback(
    (sentAt: number, s: Settings) =>
      change((t) => {
        const value = fromServer(s);
        return JSON.stringify(value) === JSON.stringify(t.confirmed) ? t : fetched(t, sentAt, value).next;
      }),
    [change],
  );

  // A failed fetch is asked again rather than settled with the defaults: `loaded` is what holds
  // the alarms and the timer's alerts, and judged against the defaults they would ring at the
  // wrong times (or not at all) until a reload.
  useEffect(() => {
    let cancelled = false;
    let retry: number | undefined;
    let delay = 0;
    const fetchSettings = () => {
      const sentAt = store.current.version;
      api
        .getSettings()
        .then((s) => {
          if (!cancelled) land(sentAt, s);
        })
        .catch(() => {
          if (cancelled) return;
          delay = nextBackoff(delay);
          retry = window.setTimeout(fetchSettings, delay);
        });
    };
    fetchSettings();
    return () => {
      cancelled = true;
      window.clearTimeout(retry);
    };
  }, [land]);

  // Then kept in step like today's day (every minute and when the tab comes back), since
  // another device may change them: a work day made longer on the phone must not ring this
  // tab's clock-out alarm at the old length. Until the first answer the retries above own the
  // fetch; a failed refresh keeps the copy shown.
  const refresh = useCallback(() => {
    if (store.current.confirmed === undefined) return Promise.resolve();
    const sentAt = store.current.version;
    return api
      .getSettings()
      .then((s) => land(sentAt, s))
      .catch(() => {});
  }, [land]);
  useRefreshLoop(refresh);

  const update = useCallback(
    async (patch: Partial<Settings>) => {
      const id = ++nextId.current;
      change((t) => addPending(t, id, (s) => ({ ...s, ...patch })));
      try {
        const saved = await inOrder(() => api.putSettings(patch));
        change((t) => settleWith(t, [id], fromServer(saved)));
      } catch (err) {
        change((t) => settle(t, [id]));
        throw err;
      }
    },
    [change, inOrder],
  );

  // Not optimistic: the server's answer is the copy of the defaults that counts. A change made
  // after it is still pending and stays on top.
  const reset = useCallback(async () => {
    const saved = await inOrder(() => api.resetSettings());
    change((t) => settleWith(t, [], fromServer(saved)));
  }, [change, inOrder]);

  // Kept by identity between changes: the alarms and the sheet key their work on it. Until the
  // first answer the defaults stand in for the server's copy, with `loaded` false, so a change
  // made meanwhile shows at once like any other.
  const settings = useMemo(() => shown({ ...tracked, confirmed: tracked.confirmed ?? DEFAULT_SETTINGS })!, [tracked]);
  const loaded = tracked.confirmed !== undefined;
  const value = useMemo(() => ({ settings, loaded, update, reset }), [settings, loaded, update, reset]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSettings(): SettingsCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSettings outside SettingsProvider');
  return v;
}
