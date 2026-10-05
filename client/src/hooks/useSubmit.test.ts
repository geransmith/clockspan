// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import type { SubmitEvent } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deferred, settle } from '../test/hooks';
import { useSubmit } from './useSubmit';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const event = (preventDefault = vi.fn()) => ({ preventDefault }) as unknown as SubmitEvent<HTMLFormElement>;

it('sends one at a time and is busy while it is out', async () => {
  const { result } = renderHook(() => useSubmit());
  const answer = deferred<void>();
  const send = vi.fn(() => answer.promise);
  const preventDefault = vi.fn();
  act(() => result.current.onSubmit(send)(event(preventDefault)));
  expect(preventDefault).toHaveBeenCalled();
  expect(result.current.busy).toBe(true);
  // A second press before the answer: the button may not have re-rendered as disabled yet.
  act(() => result.current.onSubmit(send)(event()));
  expect(send).toHaveBeenCalledTimes(1);
  answer.resolve();
  await settle();
  expect(result.current).toMatchObject({ busy: false, error: null });
  act(() => result.current.onSubmit(send)(event()));
  expect(send).toHaveBeenCalledTimes(2);
});

it('shows what a send throws, and clears it when the next one starts', async () => {
  const { result } = renderHook(() => useSubmit());
  act(() => result.current.onSubmit(() => Promise.reject(new Error('Current password is incorrect.')))(event()));
  await settle();
  expect(result.current).toMatchObject({ busy: false, error: 'Current password is incorrect.' });
  const answer = deferred<void>();
  act(() => result.current.onSubmit(() => answer.promise)(event()));
  expect(result.current.error).toBeNull();
  answer.resolve();
  await settle();
  act(() => result.current.setError('Could not load the users.'));
  expect(result.current.error).toBe('Could not load the users.');
});

it("runs a button's send with no form, under the same one-at-a-time rule", async () => {
  const { result } = renderHook(() => useSubmit());
  const answer = deferred<void>();
  const send = vi.fn(() => answer.promise);
  act(() => result.current.run(send));
  expect(result.current.busy).toBe(true);
  act(() => result.current.onSubmit(send)(event()));
  expect(send).toHaveBeenCalledTimes(1);
  answer.resolve();
  await settle();
  expect(result.current.busy).toBe(false);
});
