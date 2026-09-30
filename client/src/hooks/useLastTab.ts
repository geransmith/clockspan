import { useCallback, useState } from 'react';
import { readStored, writeStored } from '../lib/storage';

/**
 * The tab picked last time, kept under `key`, so reopening a dialog to tweak the same thing
 * doesn't start over. A stored tab that isn't offered now (Account once local accounts are
 * gone) opens `fallback` and stays stored until another tab is picked, because the tab is saved
 * when it is picked, never on open.
 */
export function useLastTab<T extends string>(key: string, tabs: readonly { id: T }[], fallback: T): [T, (tab: T) => void] {
  const [tab, setTab] = useState<T>(() => {
    const stored = readStored(key);
    return tabs.find((t) => t.id === stored)?.id ?? fallback;
  });
  const choose = useCallback(
    (next: T) => {
      writeStored(key, next);
      setTab(next);
    },
    [key],
  );
  return [tab, choose];
}
