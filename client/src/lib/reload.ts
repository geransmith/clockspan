import { readStored, writeStored } from './storage';

const KEY = 'focus:chunk-reload';
const MIN_GAP_MS = 60_000;

/**
 * A chunk that fails to load is almost always a new version: the open page asks for the
 * previous build's file, which the new image no longer has, and a reload picks up the new
 * build. Once a minute at most, so a server that can't serve the file shows the error card
 * instead of reloading forever. Returns whether it reloaded.
 */
export function reloadForNewBuild(now: number, reload: () => void): boolean {
  const last = Number(readStored(KEY));
  if (now - last < MIN_GAP_MS) return false;
  writeStored(KEY, String(now));
  reload();
  return true;
}
