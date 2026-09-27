// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { CARD_IDS } from '../../../shared/settings.js';
import { deferred, makeSettings, settle, T0 } from '../test/hooks';
import { SettingsProvider, useSettings } from './useSettings';
import { useTimeFormat } from './useTimeFormat';

vi.mock('../api');

const render = () => renderHook(() => useSettings(), { wrapper: SettingsProvider });

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('loading', () => {
  it('holds the defaults with loaded false until the server answers', async () => {
    const answer = deferred<ReturnType<typeof makeSettings>>();
    vi.mocked(api.getSettings).mockReturnValue(answer.promise);
    const { result } = render();
    expect(result.current.loaded).toBe(false);
    expect(result.current.settings.workMinutes).toBe(makeSettings().workMinutes);
    answer.resolve(makeSettings({ workMinutes: 600, layout: [{ id: 'retro', visible: false }] }));
    await settle();
    expect(result.current.loaded).toBe(true);
    expect(result.current.settings.workMinutes).toBe(600);
    // The saved layout is merged with the card registry: every card, the saved one first.
    expect(result.current.settings.layout.map((c) => c.id)).toEqual(['retro', ...CARD_IDS.filter((id) => id !== 'retro')]);
    expect(result.current.settings.layout[0]).toEqual({ id: 'retro', visible: false });
  });

  it('asks again after a failure, 2 s doubling up to a minute, and never settles on the defaults', async () => {
    vi.mocked(api.getSettings).mockRejectedValue(new Error('offline'));
    const { result } = render();
    await settle();
    const gaps = [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000];
    for (const [i, gap] of gaps.entries()) {
      expect(api.getSettings).toHaveBeenCalledTimes(i + 1);
      await settle(gap - 1);
      expect(api.getSettings).toHaveBeenCalledTimes(i + 1);
      await settle(1);
    }
    expect(api.getSettings).toHaveBeenCalledTimes(gaps.length + 1);
    expect(result.current.loaded).toBe(false);

    vi.mocked(api.getSettings).mockResolvedValue(makeSettings({ lunchDeadlineMinutes: 60 }));
    await settle(60_000);
    expect(result.current.loaded).toBe(true);
    expect(result.current.settings.lunchDeadlineMinutes).toBe(60);
  });

  it('drops an answer or a retry that lands after unmount (sign-out)', async () => {
    const late = deferred<ReturnType<typeof makeSettings>>();
    vi.mocked(api.getSettings).mockReturnValue(late.promise);
    render().unmount();
    late.resolve(makeSettings());
    await settle();

    const failing = deferred<ReturnType<typeof makeSettings>>();
    vi.mocked(api.getSettings).mockReset().mockReturnValue(failing.promise);
    const second = render();
    await settle();
    second.unmount();
    failing.reject(new Error('offline'));
    await settle(60_000);
    expect(api.getSettings).toHaveBeenCalledTimes(1);

    // A retry already scheduled is cleared too.
    vi.mocked(api.getSettings).mockReset().mockRejectedValue(new Error('offline'));
    const third = render();
    await settle();
    third.unmount();
    await settle(60_000);
    expect(api.getSettings).toHaveBeenCalledTimes(1);
  });
});

describe('update', () => {
  it('shows the change at once and adopts what the server stored', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(makeSettings());
    const saved = deferred<ReturnType<typeof makeSettings>>();
    vi.mocked(api.putSettings).mockReturnValue(saved.promise);
    const { result } = render();
    await settle();
    const done = result.current.update({ workMinutes: 540 });
    await settle();
    expect(result.current.settings.workMinutes).toBe(540);
    expect(api.putSettings).toHaveBeenCalledWith({ workMinutes: 540 });
    saved.resolve(makeSettings({ workMinutes: 540, priorityCount: 4 }));
    await settle();
    await done;
    expect(result.current.settings.priorityCount).toBe(4);
  });

  it('puts the old value back and rejects when the save fails', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(makeSettings({ workMinutes: 480 }));
    vi.mocked(api.putSettings).mockRejectedValue(new Error('offline'));
    const { result } = render();
    await settle();
    const done = result.current.update({ workMinutes: 540 });
    await expect(done).rejects.toThrow('offline');
    await settle();
    expect(result.current.settings.workMinutes).toBe(480);
  });

  it('lets only the newest of two overlapping saves settle the state', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(makeSettings({ workMinutes: 480 }));
    const first = deferred<ReturnType<typeof makeSettings>>();
    const second = deferred<ReturnType<typeof makeSettings>>();
    vi.mocked(api.putSettings).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = render();
    await settle();
    const a = result.current.update({ workMinutes: 500 });
    await settle();
    const b = result.current.update({ workMinutes: 520 });
    await settle();

    // The first answer (or failure) lands after the second was sent: it must not undo it.
    first.resolve(makeSettings({ workMinutes: 500 }));
    await a;
    await settle();
    expect(result.current.settings.workMinutes).toBe(520);
    second.resolve(makeSettings({ workMinutes: 520 }));
    await b;

    const third = deferred<ReturnType<typeof makeSettings>>();
    const fourth = deferred<ReturnType<typeof makeSettings>>();
    vi.mocked(api.putSettings).mockReturnValueOnce(third.promise).mockReturnValueOnce(fourth.promise);
    const c = result.current.update({ workMinutes: 540 });
    await settle();
    const d = result.current.update({ workMinutes: 560 });
    await settle();
    third.reject(new Error('offline'));
    await expect(c).rejects.toThrow('offline');
    await settle();
    expect(result.current.settings.workMinutes).toBe(560);
    fourth.resolve(makeSettings({ workMinutes: 560 }));
    await d;
  });
});

describe('reset', () => {
  it("adopts the server's defaults unless a save was sent after it", async () => {
    vi.mocked(api.getSettings).mockResolvedValue(makeSettings({ workMinutes: 600 }));
    vi.mocked(api.resetSettings).mockResolvedValueOnce(makeSettings());
    const { result } = render();
    await settle();
    await result.current.reset();
    await settle();
    expect(result.current.settings.workMinutes).toBe(makeSettings().workMinutes);

    const reset = deferred<ReturnType<typeof makeSettings>>();
    vi.mocked(api.resetSettings).mockReturnValueOnce(reset.promise);
    vi.mocked(api.putSettings).mockResolvedValueOnce(makeSettings({ workMinutes: 450 }));
    const r = result.current.reset();
    await result.current.update({ workMinutes: 450 });
    reset.resolve(makeSettings());
    await r;
    await settle();
    expect(result.current.settings.workMinutes).toBe(450);
  });
});

it('refuses to run outside the provider', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(() => renderHook(() => useSettings())).toThrow('useSettings outside SettingsProvider');
});

it('useTimeFormat follows the time format setting', async () => {
  vi.mocked(api.getSettings).mockResolvedValue(makeSettings({ timeFormat: '24h' }));
  const { result } = renderHook(() => useTimeFormat(), { wrapper: SettingsProvider });
  await settle();
  expect(result.current.hour12).toBe(false);
  expect(result.current.formatTime(new Date(2026, 8, 28, 14, 5).getTime())).toBe('14:05');
});
