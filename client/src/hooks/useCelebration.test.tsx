// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { playSound } from '../lib/alerts';
import { BURST_MS } from '../lib/celebrate';
import { makeSettings, settle, T0 } from '../test/hooks';
import type { Settings } from '../types';
import { useBecameTrue, useCelebration, type Moment } from './useCelebration';
import { SettingsProvider, useSettings } from './useSettings';

vi.mock('../api');
vi.mock('../lib/alerts');

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('useBecameTrue', () => {
  const render = (value: boolean | null) => renderHook(({ v }) => useBecameTrue(v), { initialProps: { v: value } });

  it('is a moment when the value turns true, and a new one each time', () => {
    const { result, rerender } = render(false);
    expect(result.current).toBeNull();
    rerender({ v: true });
    const first = result.current;
    expect(first).not.toBeNull();
    rerender({ v: true });
    expect(result.current).toBe(first);
    rerender({ v: false });
    expect(result.current).toBe(first);
    rerender({ v: true });
    expect(result.current).not.toBe(first);
    expect(result.current).not.toBeNull();
  });

  it('is no moment for a value that was already true, or that comes from not known', () => {
    const { result, rerender } = render(true);
    expect(result.current).toBeNull();
    rerender({ v: null });
    rerender({ v: true });
    expect(result.current).toBeNull();
    // Not known in between: false, then unknown, then true is no moment either.
    rerender({ v: false });
    rerender({ v: null });
    rerender({ v: true });
    expect(result.current).toBeNull();
  });
});

describe('useCelebration', () => {
  const rect = { left: 10, top: 20, width: 30, height: 40 } as DOMRect;
  const anchorEl = () => Object.assign(document.createElement('div'), { getBoundingClientRect: () => rect });

  async function render(settings: Partial<Settings>, withAnchor = true) {
    vi.mocked(api.getSettings).mockResolvedValue(makeSettings(settings));
    vi.mocked(api.putSettings).mockImplementation((patch) => Promise.resolve(makeSettings({ ...settings, ...patch })));
    const hook = renderHook(({ moment }: { moment: Moment | null }) => ({ c: useCelebration<HTMLDivElement>(moment, 'weekDone'), s: useSettings() }), {
      initialProps: { moment: null as Moment | null },
      wrapper: SettingsProvider,
    });
    await settle();
    if (withAnchor) hook.result.current.c.anchor.current = anchorEl();
    return hook;
  }

  it("plays the event's sound and bursts from the anchor for as long as a burst lives", async () => {
    const { result, rerender } = await render({ sounds: { ...makeSettings().sounds, weekDone: 'bell' } });
    expect(result.current.c.burst).toBeNull();
    expect(playSound).not.toHaveBeenCalled();
    rerender({ moment: {} });
    expect(playSound).toHaveBeenCalledExactlyOnceWith('bell');
    expect(result.current.c.burst).toEqual({ seed: T0, anchor: rect });
    await settle(BURST_MS);
    expect(result.current.c.burst).toBeNull();
  });

  it('stays quiet with sound off and still bursts', async () => {
    const { result, rerender } = await render({ sound: false });
    rerender({ moment: {} });
    expect(playSound).not.toHaveBeenCalled();
    expect(result.current.c.burst).not.toBeNull();
  });

  it('plays the sound with no burst when celebrations are off or nothing is there to fly from', async () => {
    const off = await render({ celebrations: false });
    off.rerender({ moment: {} });
    expect(playSound).toHaveBeenCalledTimes(1);
    expect(off.result.current.c.burst).toBeNull();
    cleanup();
    const bare = await render({}, false);
    bare.rerender({ moment: {} });
    expect(playSound).toHaveBeenCalledTimes(2);
    expect(bare.result.current.c.burst).toBeNull();
  });

  it('a settings change replays nothing, the next moment reads the new settings, and a newer moment hides a burst still flying', async () => {
    const { result, rerender } = await render({});
    rerender({ moment: {} });
    expect(playSound).toHaveBeenCalledTimes(1);
    expect(result.current.c.burst).not.toBeNull();
    await act(() => result.current.s.update({ celebrations: false }));
    expect(playSound).toHaveBeenCalledTimes(1);
    rerender({ moment: {} });
    expect(playSound).toHaveBeenCalledTimes(2);
    expect(result.current.c.burst).toBeNull();
  });
});
