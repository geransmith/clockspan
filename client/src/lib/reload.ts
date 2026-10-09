import { MINUTE_MS } from '../../../shared/dates.js';
import { readStored, writeStored } from './storage';

const KEY = 'focus:chunk-reload';
const MIN_GAP_MS = MINUTE_MS;

/**
 * A chunk that fails to load while online is almost always a new version: the open page asks
 * for the previous build's file, which the new image no longer has, and a reload picks up the
 * new build. Offline it is the lost network, and a reload would only trade the error card for
 * the browser's offline page and drop the saves still queued, so nothing happens. Once a minute
 * at most, so a server that can't serve the file shows the error card instead of reloading
 * forever.
 */
export function reloadForNewBuild(now: number, reload: () => void, online = true): void {
  if (!online) return;
  const last = Number(readStored(KEY));
  if (now - last < MIN_GAP_MS) return;
  writeStored(KEY, String(now));
  reload();
}
