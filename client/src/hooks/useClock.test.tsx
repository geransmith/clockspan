// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { settle, T0 } from '../test/hooks';
import { ClockProvider, useClock } from './useClock';

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('hands every reader the same tick, once a second', async () => {
  const { result } = renderHook(() => [useClock(), useClock()], { wrapper: ClockProvider });
  expect(result.current).toEqual([T0, T0]);
  await settle(1000);
  expect(result.current).toEqual([T0 + 1000, T0 + 1000]);
});

it('refuses to run outside the provider', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(() => renderHook(() => useClock())).toThrow('useClock outside ClockProvider');
});
