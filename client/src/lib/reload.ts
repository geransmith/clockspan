import { MINUTE_MS } from '../../../shared/dates.js';
import { whenIdle } from './optimistic';
import { readStored, writeStored } from './storage';

const KEY = 'focus:chunk-reload';
const MIN_GAP_MS = MINUTE_MS;

/**
 * A chunk that fails to load while online is almost always a new version: the open page asks
 * for the previous build's file, which the new image no longer has, and a reload picks up the
 * new build. A reload drops the saves still on their way, so it waits for them (`whenIdle`, which
 * each request's timeout ends) and judges the network and the clock once they have settled.
 * Offline it is the lost network, and a reload would only trade the error card for the browser's
 * offline page, so nothing happens. Once a minute at most, so a server that can't serve the file
 * shows the error card instead of reloading forever. The gap counts either way, so a time stored
 * ahead of now (the clock set back since) doesn't hold every reload off until the clock catches up.
 */
export async function reloadForNewBuild(reload: () => void): Promise<void> {
  await whenIdle();
  if (!navigator.onLine) return;
  const now = Date.now();
  const last = Number(readStored(KEY));
  if (Math.abs(now - last) < MIN_GAP_MS) return;
  writeStored(KEY, String(now));
  reload();
}
