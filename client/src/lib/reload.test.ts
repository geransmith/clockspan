// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest';
import { MINUTE_MS } from '../../../shared/dates.js';
import { reloadForNewBuild } from './reload';

beforeEach(() => localStorage.clear());

it('reloads for a chunk that failed, then not again within a minute', () => {
  const reload = vi.fn();
  reloadForNewBuild(1_000_000, reload);
  expect(reload).toHaveBeenCalledTimes(1);
  reloadForNewBuild(1_000_000 + 59_999, reload);
  expect(reload).toHaveBeenCalledTimes(1);
  reloadForNewBuild(1_000_000 + MINUTE_MS, reload);
  expect(reload).toHaveBeenCalledTimes(2);
});

it('reloads when what is stored is not a time', () => {
  localStorage.setItem('focus:chunk-reload', 'soon');
  const reload = vi.fn();
  reloadForNewBuild(5, reload);
  expect(reload).toHaveBeenCalledTimes(1);
});
