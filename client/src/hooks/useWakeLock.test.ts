// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deferred, settle, setVisibility } from '../test/hooks';
import { useWakeLock } from './useWakeLock';

/** The smallest Screen Wake Lock: each request hands out a sentinel the test can release. */
class FakeSentinel {
  released = false;
  release = vi.fn(() => {
    this.released = true;
    return Promise.resolve();
  });
}
let request: ReturnType<typeof vi.fn<() => Promise<FakeSentinel>>>;
const granted: FakeSentinel[] = [];

const render = (active = true) => renderHook((p: { active: boolean }) => useWakeLock(p.active), { initialProps: { active } });

beforeEach(() => {
  vi.useFakeTimers();
  granted.length = 0;
  request = vi.fn(() => {
    const s = new FakeSentinel();
    granted.push(s);
    return Promise.resolve(s);
  });
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request } });
  setVisibility('visible');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (navigator as { wakeLock?: unknown }).wakeLock;
});

it('holds a lock while active and lets it go when not', async () => {
  const { rerender } = render(false);
  await settle();
  expect(request).not.toHaveBeenCalled();
  rerender({ active: true });
  await settle();
  expect(request).toHaveBeenCalledWith('screen');
  rerender({ active: false });
  await settle();
  expect(granted[0]!.release).toHaveBeenCalled();
});

it('asks again when the page comes back after the OS let the lock go, never twice', async () => {
  render();
  await settle();
  act(() => setVisibility('visible')); // still held: no second request
  await settle();
  expect(request).toHaveBeenCalledTimes(1);
  granted[0]!.released = true; // hidden: the OS releases it
  act(() => setVisibility('hidden'));
  await settle();
  expect(request).toHaveBeenCalledTimes(1);
  act(() => setVisibility('visible'));
  await settle();
  expect(request).toHaveBeenCalledTimes(2);
});

it('does not ask from a hidden page', async () => {
  setVisibility('hidden');
  render();
  await settle();
  expect(request).not.toHaveBeenCalled();
});

it('releases a lock that arrives after it stopped being wanted', async () => {
  const pending = deferred<FakeSentinel>();
  request.mockReturnValueOnce(pending.promise);
  const { rerender } = render();
  rerender({ active: false });
  const late = new FakeSentinel();
  pending.resolve(late);
  await settle();
  expect(late.release).toHaveBeenCalled();
});

it('shrugs off a refused request', async () => {
  request.mockRejectedValueOnce(new Error('NotAllowedError'));
  render().unmount();
  await settle();
  expect(request).toHaveBeenCalledTimes(1);
});

it('does nothing where the browser has no wake lock', async () => {
  delete (navigator as { wakeLock?: unknown }).wakeLock;
  render().unmount();
  await settle();
  expect(request).not.toHaveBeenCalled();
});
