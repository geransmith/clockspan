// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { T0, TODAY } from '../test/hooks';
import { useRoute } from './useRoute';

const visit = (url: string) => history.replaceState(null, '', url);
const render = () => renderHook(() => useRoute());

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  visit('/');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('reading the URL', () => {
  it("is today's sheet by default", () => {
    expect(render().result.current[0]).toEqual({ view: 'sheet', date: null });
  });

  it('takes a valid past date and the history view', () => {
    visit('/?view=history&date=2026-09-25');
    expect(render().result.current[0]).toEqual({ view: 'history', date: '2026-09-25' });
  });

  it("treats today's date, a bad date and an unknown view as the defaults", () => {
    visit(`/?date=${TODAY}`);
    expect(render().result.current[0]).toEqual({ view: 'sheet', date: null });
    visit('/?view=nope&date=2026-02-30');
    expect(render().result.current[0]).toEqual({ view: 'sheet', date: null });
  });

  it('opens today for a date that has not come yet', () => {
    visit('/?view=history&date=2030-01-01');
    expect(render().result.current[0]).toEqual({ view: 'history', date: null });
  });
});

describe('navigate', () => {
  it('pushes one history entry per move and keeps today as no date', () => {
    const push = vi.spyOn(history, 'pushState');
    const { result } = render();
    act(() => result.current[1]({ date: '2026-09-25' }));
    expect(result.current[0]).toEqual({ view: 'sheet', date: '2026-09-25' });
    expect(window.location.search).toBe('?date=2026-09-25');
    act(() => result.current[1]({ view: 'history' }));
    expect(window.location.search).toBe('?view=history&date=2026-09-25');
    act(() => result.current[1]({ view: 'sheet', date: TODAY }));
    expect(result.current[0]).toEqual({ view: 'sheet', date: null });
    expect(window.location.search).toBe('');
    expect(push).toHaveBeenCalledTimes(3);
  });

  it('lands on today for a future date, as a typed date past the picker max would ask', () => {
    const { result } = render();
    act(() => result.current[1]({ date: '2026-09-25' }));
    act(() => result.current[1]({ date: '2030-01-01' }));
    expect(result.current[0]).toEqual({ view: 'sheet', date: null });
    expect(window.location.search).toBe('');
  });

  it('pushes nothing when already there', () => {
    const push = vi.spyOn(history, 'pushState');
    const { result } = render();
    act(() => result.current[1]({ date: TODAY }));
    expect(push).not.toHaveBeenCalled();
  });

  it('follows Back and Forward', () => {
    const { result, unmount } = render();
    visit('/?view=history');
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(result.current[0]).toEqual({ view: 'history', date: null });
    unmount();
  });
});
