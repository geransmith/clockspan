// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest';
import { HOUR_MS, MINUTE_MS } from '../../../shared/dates.js';
import { deferred } from '../test/fixtures';
import { whileUnsettled } from './optimistic';
import { reloadForNewBuild } from './reload';

const T0 = 1_000_000_000;

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

it('reloads for a chunk that failed, then not again within a minute', async () => {
  const reload = vi.fn();
  await reloadForNewBuild(reload);
  expect(reload).toHaveBeenCalledTimes(1);
  vi.setSystemTime(T0 + MINUTE_MS - 1);
  await reloadForNewBuild(reload);
  expect(reload).toHaveBeenCalledTimes(1);
  vi.setSystemTime(T0 + MINUTE_MS);
  await reloadForNewBuild(reload);
  expect(reload).toHaveBeenCalledTimes(2);
});

it('reloads when the time stored is ahead of now by a minute or more (the clock set back)', async () => {
  localStorage.setItem('focus:chunk-reload', String(T0 + HOUR_MS));
  const reload = vi.fn();
  await reloadForNewBuild(reload);
  expect(reload).toHaveBeenCalledTimes(1);
});

it('reloads when what is stored is not a time', async () => {
  localStorage.setItem('focus:chunk-reload', 'soon');
  const reload = vi.fn();
  await reloadForNewBuild(reload);
  expect(reload).toHaveBeenCalledTimes(1);
});

it('neither reloads nor records an attempt while offline', async () => {
  vi.stubGlobal('navigator', { onLine: false });
  const reload = vi.fn();
  await reloadForNewBuild(reload);
  expect(reload).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await reloadForNewBuild(reload);
  expect(reload).toHaveBeenCalledTimes(1);
});

it('waits for the saves still on their way, and records the time it reloads at', async () => {
  const save = deferred<void>();
  void whileUnsettled(save.promise);
  const reload = vi.fn();
  const done = reloadForNewBuild(reload);
  await Promise.resolve();
  expect(reload).not.toHaveBeenCalled();
  vi.setSystemTime(T0 + MINUTE_MS / 2);
  save.resolve();
  await done;
  expect(reload).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem('focus:chunk-reload')).toBe(String(T0 + MINUTE_MS / 2));
});
