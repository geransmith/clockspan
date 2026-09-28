// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest';
import { reloadForNewBuild } from './reload';

beforeEach(() => localStorage.clear());

it('reloads for a chunk that failed, then not again within a minute', () => {
  const reload = vi.fn();
  expect(reloadForNewBuild(1_000_000, reload)).toBe(true);
  expect(reload).toHaveBeenCalledTimes(1);
  expect(reloadForNewBuild(1_000_000 + 59_999, reload)).toBe(false);
  expect(reload).toHaveBeenCalledTimes(1);
  expect(reloadForNewBuild(1_000_000 + 60_000, reload)).toBe(true);
  expect(reload).toHaveBeenCalledTimes(2);
});

it('reloads when what is stored is not a time', () => {
  localStorage.setItem('focus:chunk-reload', 'soon');
  const reload = vi.fn();
  expect(reloadForNewBuild(5, reload)).toBe(true);
});
