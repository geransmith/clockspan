// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { CARD_IDS, DEFAULT_SETTINGS } from '../../../shared/settings.js';
import { deferred, makeSettings, MIN, settle, setVisibility, T0 } from '../test/hooks';
import type { Settings } from '../types';
import { SettingsProvider, useSettings } from './useSettings';

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
    expect(result.current.settings.workMinutes).toBe(DEFAULT_SETTINGS.workMinutes);
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

  it('drops the answer or the retry of a fetch whose effect was cleaned up (StrictMode, sign-out)', async () => {
    // StrictMode runs the effect twice, cleaning up the first run the way an unmount would. Its
    // answer lands after the second run's and is older, so it must not show.
    const late = deferred<ReturnType<typeof makeSettings>>();
    vi.mocked(api.getSettings)
      .mockReturnValueOnce(late.promise)
      .mockResolvedValueOnce(makeSettings({ workMinutes: 540 }));
    const strict = renderHook(() => useSettings(), { wrapper: SettingsProvider, reactStrictMode: true });
    await settle();
    expect(api.getSettings).toHaveBeenCalledTimes(2);
    late.resolve(makeSettings({ workMinutes: 480 }));
    await settle();
    expect(strict.result.current.settings.workMinutes).toBe(540);
    strict.unmount();

    // Signed out with the fetch still out: its failure schedules no retry.
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

describe('refresh', () => {
  it('reads the settings again every minute and when the tab comes back, and keeps them on a failure', async () => {
    vi.mocked(api.getSettings)
      .mockResolvedValueOnce(makeSettings())
      .mockResolvedValueOnce(makeSettings({ workMinutes: 540 }))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(makeSettings({ workMinutes: 600 }));
    const { result } = render();
    await settle();
    // The work day was made longer on the phone.
    await settle(MIN);
    expect(api.getSettings).toHaveBeenCalledTimes(2);
    expect(result.current.settings.workMinutes).toBe(540);
    await settle(MIN);
    expect(api.getSettings).toHaveBeenCalledTimes(3);
    expect(result.current).toMatchObject({ loaded: true, settings: { workMinutes: 540 } });
    await settle(10_000);
    act(() => setVisibility('visible'));
    await settle();
    expect(api.getSettings).toHaveBeenCalledTimes(4);
    expect(result.current.settings.workMinutes).toBe(600);
  });

  it('keeps the same settings object when the answer has not changed', async () => {
    vi.mocked(api.getSettings).mockImplementation(() => Promise.resolve(makeSettings({ workMinutes: 540 })));
    const { result } = render();
    await settle();
    const before = result.current.settings;
    await settle(MIN);
    expect(api.getSettings).toHaveBeenCalledTimes(2);
    expect(result.current.settings).toBe(before);
  });

  it('never hides a save on its way, nor undoes one that answered after the refresh went out', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(makeSettings({ workMinutes: 480 }));
    const saved = deferred<Settings>();
    vi.mocked(api.putSettings).mockReturnValueOnce(saved.promise);
    const { result } = render();
    await settle();
    const done = result.current.update({ workMinutes: 540 });
    await settle(MIN);
    expect(api.getSettings).toHaveBeenCalledTimes(2);
    expect(result.current.settings.workMinutes).toBe(540);
    saved.resolve(makeSettings({ workMinutes: 540 }));
    await done;

    // The next refresh was read before the next save, and answers after it.
    const late = deferred<Settings>();
    vi.mocked(api.getSettings).mockReturnValueOnce(late.promise);
    vi.mocked(api.putSettings).mockResolvedValueOnce(makeSettings({ workMinutes: 600 }));
    await settle(MIN);
    await act(() => result.current.update({ workMinutes: 600 }));
    late.resolve(makeSettings({ workMinutes: 540 }));
    await settle();
    expect(result.current.settings.workMinutes).toBe(600);
  });
});

describe('update', () => {
  it('shows a change made before the first answer over the defaults, with loaded still false', async () => {
    vi.mocked(api.getSettings).mockRejectedValue(new Error('offline'));
    const saved = deferred<Settings>();
    vi.mocked(api.putSettings).mockReturnValueOnce(saved.promise);
    const { result } = render();
    await settle();
    const sound = !DEFAULT_SETTINGS.sound;
    const done = result.current.update({ sound });
    await settle();
    expect(result.current).toMatchObject({ loaded: false, settings: { sound, workMinutes: DEFAULT_SETTINGS.workMinutes } });
    // The server is down for the save too: back to the defaults.
    saved.reject(new Error('offline'));
    await expect(done).rejects.toThrow('offline');
    await settle();
    expect(result.current.settings).toEqual(DEFAULT_SETTINGS);
  });

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

  it('shows the stored settings after two saves in a row fail, not the first guess', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(makeSettings({ workMinutes: 480 }));
    const first = deferred<ReturnType<typeof makeSettings>>();
    const second = deferred<ReturnType<typeof makeSettings>>();
    vi.mocked(api.putSettings).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = render();
    await settle();
    const a = result.current.update({ workMinutes: 500 });
    await settle();
    const b = result.current.update({ priorityCount: 5 });
    await settle();
    expect(result.current.settings).toMatchObject({ workMinutes: 500, priorityCount: 5 });
    first.reject(new Error('offline'));
    await expect(a).rejects.toThrow('offline');
    await settle();
    // The first is gone; the second is still on its way and still shows.
    expect(result.current.settings).toMatchObject({ workMinutes: 480, priorityCount: 5 });
    second.reject(new Error('offline'));
    await expect(b).rejects.toThrow('offline');
    await settle();
    expect(result.current.settings).toMatchObject({ workMinutes: 480, priorityCount: 3 });
  });

  it("takes a save's answer as loaded, and drops the first load when it answers later", async () => {
    const first = deferred<ReturnType<typeof makeSettings>>();
    vi.mocked(api.getSettings).mockReturnValueOnce(first.promise);
    vi.mocked(api.putSettings).mockResolvedValue(makeSettings({ workMinutes: 500 }));
    const { result } = render();
    await result.current.update({ workMinutes: 500 });
    await settle();
    // The answer is all the settings, as stored.
    expect(result.current).toMatchObject({ loaded: true, settings: { workMinutes: 500 } });
    // The load was read before the save.
    first.resolve(makeSettings());
    await settle();
    expect(api.getSettings).toHaveBeenCalledTimes(1);
    expect(result.current.settings.workMinutes).toBe(500);
  });

  it('sends overlapping saves one at a time, and lets only the newest settle the state', async () => {
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
    // The second waits for the first, so the server takes them in the order they were made.
    expect(api.putSettings).toHaveBeenCalledTimes(1);
    expect(result.current.settings.workMinutes).toBe(520);

    // The first answer lands after the second change: it must not undo it.
    first.resolve(makeSettings({ workMinutes: 500 }));
    await a;
    await settle();
    expect(api.putSettings).toHaveBeenLastCalledWith({ workMinutes: 520 });
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
    // A failed save still lets the next one go.
    third.reject(new Error('offline'));
    await expect(c).rejects.toThrow('offline');
    await settle();
    expect(api.putSettings).toHaveBeenLastCalledWith({ workMinutes: 560 });
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

    // A save made while the reset is out goes after it, and its answer is the one that counts.
    const reset = deferred<ReturnType<typeof makeSettings>>();
    const saved = deferred<ReturnType<typeof makeSettings>>();
    vi.mocked(api.resetSettings).mockReturnValueOnce(reset.promise);
    vi.mocked(api.putSettings).mockReturnValueOnce(saved.promise);
    const r = result.current.reset();
    const u = result.current.update({ workMinutes: 450 });
    await settle();
    expect(api.putSettings).not.toHaveBeenCalled();
    reset.resolve(makeSettings());
    await r;
    await settle();
    // The defaults are in, and the change made while they were out still shows over them.
    expect(api.putSettings).toHaveBeenCalledWith({ workMinutes: 450 });
    expect(result.current.settings.workMinutes).toBe(450);
    saved.resolve(makeSettings({ workMinutes: 450 }));
    await u;
    await settle();
    expect(result.current.settings.workMinutes).toBe(450);
  });
});

it('refuses to run outside the provider', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(() => renderHook(() => useSettings())).toThrow('useSettings outside SettingsProvider');
});
