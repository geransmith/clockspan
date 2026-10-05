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
});

describe('reading the URL', () => {
  it("is today's sheet by default", () => {
    expect(render().result.current[0]).toEqual({ view: 'sheet', date: null, review: null });
  });

  it('takes a valid past date and the history view', () => {
    visit('/?view=history&date=2026-09-25');
    expect(render().result.current[0]).toEqual({ view: 'history', date: '2026-09-25', review: null });
  });

  it("treats today's date, a bad date and an unknown view as the defaults", () => {
    visit(`/?date=${TODAY}`);
    expect(render().result.current[0]).toEqual({ view: 'sheet', date: null, review: null });
    visit('/?view=nope&date=2026-02-30');
    expect(render().result.current[0]).toEqual({ view: 'sheet', date: null, review: null });
  });

  it('opens today for a date that has not come yet', () => {
    visit('/?view=history&date=2030-01-01');
    expect(render().result.current[0]).toEqual({ view: 'history', date: null, review: null });
  });

  it('takes the review period on the history view, from the first day of the period', () => {
    visit('/?view=history&date=2026-07-14&review=month&from=2026-07-14');
    expect(render().result.current[0]).toEqual({ view: 'history', date: '2026-07-14', review: { kind: 'month', from: '2026-07-01' } });
    cleanup();
    // This week's Monday is today.
    visit(`/?view=history&review=week&from=${TODAY}`);
    expect(render().result.current[0].review).toEqual({ kind: 'week', from: TODAY });
  });

  it('ignores the review period on the sheet, and one with an unknown kind or a missing, bad or future start', () => {
    for (const url of [
      '/?review=month&from=2026-07-01',
      '/?view=history&review=year&from=2026-07-01',
      '/?view=history&review=month',
      '/?view=history&review=month&from=2026-02-30',
      '/?view=history&review=week&from=2026-10-05',
    ]) {
      visit(url);
      expect(render().result.current[0].review, url).toBeNull();
      cleanup();
    }
  });
});

describe('navigate', () => {
  it('pushes one history entry per move and keeps today as no date', () => {
    const push = vi.spyOn(history, 'pushState');
    const { result } = renderHook(() => useRoute(), { reactStrictMode: true });
    act(() => result.current[1]({ date: '2026-09-25' }));
    expect(result.current[0]).toEqual({ view: 'sheet', date: '2026-09-25', review: null });
    expect(window.location.search).toBe('?date=2026-09-25');
    act(() => result.current[1]({ view: 'history' }));
    expect(window.location.search).toBe('?view=history&date=2026-09-25');
    act(() => result.current[1]({ view: 'sheet', date: TODAY }));
    expect(result.current[0]).toEqual({ view: 'sheet', date: null, review: null });
    expect(window.location.search).toBe('');
    expect(push).toHaveBeenCalledTimes(3);
  });

  it('lands on today for a future date, as a typed date past the picker max would ask', () => {
    const { result } = render();
    act(() => result.current[1]({ date: '2026-09-25' }));
    act(() => result.current[1]({ date: '2030-01-01' }));
    expect(result.current[0]).toEqual({ view: 'sheet', date: null, review: null });
    expect(window.location.search).toBe('');
  });

  it('records a day on the current entry before pushing it, so Back returns there', () => {
    visit('/?view=history');
    const { result } = render();
    const push = vi.spyOn(history, 'pushState');
    const replace = vi.spyOn(history, 'replaceState');
    act(() => {
      const nav = result.current[1];
      nav({ date: '2026-07-14' }, { replace: true });
      nav({ view: 'sheet', date: '2026-07-14' });
    });
    expect(replace).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith(null, '', '/?view=history&date=2026-07-14');
    expect(push).toHaveBeenCalledOnce();
    expect(window.location.search).toBe('?date=2026-07-14');
    expect(result.current[0]).toEqual({ view: 'sheet', date: '2026-07-14', review: null });
    act(() => history.back());
    expect(result.current[0]).toEqual({ view: 'history', date: '2026-07-14', review: null });
    expect(window.location.search).toBe('?view=history&date=2026-07-14');
  });

  it('records the review period a day was opened from, so Back reopens the review on it', () => {
    visit('/?view=history');
    const { result } = render();
    act(() => {
      const nav = result.current[1];
      nav({ date: '2026-07-14', review: { kind: 'month', from: '2026-07-01' } }, { replace: true });
      nav({ view: 'sheet', date: '2026-07-14' });
    });
    expect(window.location.search).toBe('?date=2026-07-14');
    expect(result.current[0]).toEqual({ view: 'sheet', date: '2026-07-14', review: null });
    act(() => history.back());
    expect(result.current[0]).toEqual({ view: 'history', date: '2026-07-14', review: { kind: 'month', from: '2026-07-01' } });
    expect(window.location.search).toBe('?view=history&date=2026-07-14&review=month&from=2026-07-01');
  });

  it('writes a replace that changes only the review period', () => {
    visit('/?view=history&date=2026-07-14');
    const { result } = render();
    const replace = vi.spyOn(history, 'replaceState');
    act(() => result.current[1]({ review: { kind: 'week', from: '2026-07-13' } }, { replace: true }));
    expect(replace).toHaveBeenCalledWith(null, '', '/?view=history&date=2026-07-14&review=week&from=2026-07-13');
    expect(result.current[0].review).toEqual({ kind: 'week', from: '2026-07-13' });
  });

  it('pushes nothing when already there', () => {
    const push = vi.spyOn(history, 'pushState');
    const { result } = render();
    act(() => result.current[1]({ date: TODAY }));
    expect(push).not.toHaveBeenCalled();
  });
});
