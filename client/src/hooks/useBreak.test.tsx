// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as api from '../api';
import { alert, dismissByTag } from '../lib/alerts';
import { makeSettings, MIN, settle, T0 } from '../test/hooks';
import { BreakProvider, useBreak } from './useBreak';
import { SettingsProvider } from './useSettings';

vi.mock('../api');
vi.mock('../lib/alerts');

const settings = makeSettings({ breakMinutes: 5 });
const wrapper = ({ children }: { children: ReactNode }) => (
  <SettingsProvider>
    <BreakProvider>{children}</BreakProvider>
  </SettingsProvider>
);
const render = () => renderHook(() => useBreak(), { wrapper });

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  localStorage.clear();
  vi.mocked(api.getSettings).mockResolvedValue(settings);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

it('counts a break down and announces its end once, with the Break over sound', async () => {
  const { result } = render();
  await settle();
  expect(result.current.endsAt).toBeNull();
  act(() => result.current.start());
  expect(dismissByTag).toHaveBeenCalledWith('break');
  expect(result.current.endsAt).toBe(T0 + 5 * MIN);
  expect(result.current.remainingSeconds).toBe(300);
  await settle(2 * MIN);
  expect(result.current.remainingSeconds).toBe(180);
  expect(alert).not.toHaveBeenCalled();
  await settle(3 * MIN);
  expect(result.current.endsAt).toBeNull();
  expect(alert).toHaveBeenCalledTimes(1);
  expect(alert).toHaveBeenCalledWith(
    expect.objectContaining({ tag: 'break', chime: settings.sounds.breakDone, sound: settings.sound, notifications: settings.notifications }),
  );
  await settle(MIN);
  expect(alert).toHaveBeenCalledTimes(1);
});

it('keeps a break across a reload, and a reload after the end does not announce it again', async () => {
  const first = render();
  await settle();
  act(() => first.result.current.start());
  first.unmount();
  const second = render();
  await settle();
  expect(second.result.current.endsAt).toBe(T0 + 5 * MIN);
  await settle(5 * MIN);
  expect(alert).toHaveBeenCalledTimes(1);
  second.unmount();
  render();
  await settle(MIN);
  expect(alert).toHaveBeenCalledTimes(1);
});

it('ends early without an alert', async () => {
  const { result } = render();
  await settle();
  act(() => result.current.start());
  act(() => result.current.end());
  expect(result.current.endsAt).toBeNull();
  await settle(10 * MIN);
  expect(alert).not.toHaveBeenCalled();
});

it('drops, without an alert, a break that ended long before the page opened', async () => {
  localStorage.setItem('focus:break', JSON.stringify({ endsAt: T0 - 30 * MIN }));
  const { result } = render();
  await settle();
  expect(result.current.endsAt).toBeNull();
  expect(alert).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem('focus:break')!)).toEqual({ endsAt: null });
});

it('ignores a stored value that is not a break', async () => {
  localStorage.setItem('focus:break', '"soon"');
  const { result } = render();
  await settle();
  expect(result.current.endsAt).toBeNull();
});

it('waits for the settings before announcing, so the chosen sound plays', async () => {
  localStorage.setItem('focus:break', JSON.stringify({ endsAt: T0 - MIN }));
  let answer!: (s: typeof settings) => void;
  vi.mocked(api.getSettings).mockReturnValue(new Promise((r) => (answer = r)));
  render();
  await settle();
  expect(alert).not.toHaveBeenCalled();
  answer({ ...settings, sounds: { ...settings.sounds, breakDone: 'bell' } });
  await settle();
  expect(alert).toHaveBeenCalledWith(expect.objectContaining({ chime: 'bell' }));
});

it('is only there inside its provider', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(() => renderHook(() => useBreak())).toThrow('useBreak outside BreakProvider');
});
