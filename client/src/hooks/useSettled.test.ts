// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { settle, T0 } from '../test/hooks';
import { useSettled } from './useSettled';

const render = () => renderHook((p: { value: number; ms: number }) => useSettled(p.value, p.ms), { initialProps: { value: 1, ms: 3000 } });

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});

it('passes a value on once it has stopped changing', async () => {
  const { result, rerender } = render();
  rerender({ value: 2, ms: 3000 });
  await settle(2000);
  rerender({ value: 3, ms: 3000 });
  await settle(2999);
  expect(result.current).toBe(1);
  await settle(1);
  expect(result.current).toBe(3);
});

it('waits a longer delay, and a new delay counts from when it changes', async () => {
  const { result, rerender } = render();
  rerender({ value: 2, ms: 300_000 });
  await settle(299_999);
  expect(result.current).toBe(1);
  await settle(1);
  expect(result.current).toBe(2);

  rerender({ value: 3, ms: 300_000 });
  await settle(10_000);
  expect(result.current).toBe(2);
  rerender({ value: 3, ms: 3000 });
  await settle(2_999);
  expect(result.current).toBe(2);
  await settle(1);
  expect(result.current).toBe(3);
});
