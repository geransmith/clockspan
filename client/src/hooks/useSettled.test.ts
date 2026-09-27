// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { settle, T0 } from '../test/hooks';
import { useSettled } from './useSettled';

const render = () => renderHook((p: { value: number; hold: boolean }) => useSettled(p.value, 3000, p.hold), { initialProps: { value: 1, hold: false } });

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('passes a value on once it has stopped changing', async () => {
  const { result, rerender } = render();
  rerender({ value: 2, hold: false });
  await settle(2000);
  rerender({ value: 3, hold: false });
  await settle(2999);
  expect(result.current).toBe(1);
  await settle(1);
  expect(result.current).toBe(3);
});

it('holds the last settled value while held, and starts counting on release', async () => {
  const { result, rerender } = render();
  rerender({ value: 2, hold: true });
  await settle(10_000);
  expect(result.current).toBe(1);
  rerender({ value: 2, hold: false });
  await settle(3000);
  expect(result.current).toBe(2);
});
