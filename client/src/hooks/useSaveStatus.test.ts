// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deferred, settle } from '../test/hooks';
import { useSaveStatus } from './useSaveStatus';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Starts a save whose answer the test gives by hand. */
function start(save: ReturnType<typeof useSaveStatus>['save']) {
  const answer = deferred<void>();
  let done!: Promise<void>;
  act(() => {
    done = save(() => answer.promise);
  });
  return { answer, done };
}

it('says saving, then saved once the server answers, then nothing after 2.5 s', async () => {
  const { result } = renderHook(() => useSaveStatus());
  expect(result.current.saveState).toBe('idle');
  const { answer } = start(result.current.save);
  expect(result.current.saveState).toBe('saving');
  answer.resolve();
  await settle();
  expect(result.current.saveState).toBe('saved');
  await settle(2499);
  expect(result.current.saveState).toBe('saved');
  await settle(1);
  expect(result.current.saveState).toBe('idle');
});

it('says not saved when the save fails, and keeps saying it', async () => {
  const { result } = renderHook(() => useSaveStatus());
  const { answer, done } = start(result.current.save);
  answer.reject(new Error('Request failed (500)'));
  await settle();
  // The hook says so instead of passing the failure on.
  await expect(done).resolves.toBeUndefined();
  expect(result.current.saveState).toBe('failed');
  await settle(10_000);
  expect(result.current.saveState).toBe('failed');
});

it('reads a burst of saves as one: saving until the last answers, failed if any of them failed', async () => {
  const { result } = renderHook(() => useSaveStatus());
  const first = start(result.current.save);
  const second = start(result.current.save);
  first.answer.reject(new Error('Request failed (500)'));
  await settle();
  expect(result.current.saveState).toBe('saving');
  second.answer.resolve();
  await settle();
  expect(result.current.saveState).toBe('failed');
});

it('starts clean after a failure: the next save on its own says saved', async () => {
  const { result } = renderHook(() => useSaveStatus());
  const failed = start(result.current.save);
  failed.answer.reject(new Error('Request failed (500)'));
  await settle();
  const next = start(result.current.save);
  expect(result.current.saveState).toBe('saving');
  next.answer.resolve();
  await settle();
  expect(result.current.saveState).toBe('saved');
});

it('keeps saying saving when a new save starts before the last "saved" has gone', async () => {
  const { result } = renderHook(() => useSaveStatus());
  const first = start(result.current.save);
  first.answer.resolve();
  await settle(2000);
  expect(result.current.saveState).toBe('saved');
  const second = start(result.current.save);
  // Past the first save's 2.5 s: its timer must not blank the header mid-save.
  await settle(1000);
  expect(result.current.saveState).toBe('saving');
  second.answer.resolve();
  await settle();
  expect(result.current.saveState).toBe('saved');
});

it('leaves no "saved" timer behind when it unmounts', async () => {
  const { result, unmount } = renderHook(() => useSaveStatus());
  start(result.current.save).answer.resolve();
  await settle();
  expect(vi.getTimerCount()).toBe(1);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
