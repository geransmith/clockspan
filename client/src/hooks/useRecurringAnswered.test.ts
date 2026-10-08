// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { USER_KEYS } from '../lib/storage';
import { TODAY } from '../test/fixtures';
import { useRecurringAnswered } from './useRecurringAnswered';

const TOMORROW = '2026-09-29';
const render = (today = TODAY) => renderHook((p: { today: string }) => useRecurringAnswered(p.today), { initialProps: { today } });

beforeEach(() => localStorage.clear());
afterEach(cleanup);

it("reads today's answers from this device, and none from another day", () => {
  localStorage.setItem(USER_KEYS.recurringAnswered, `${TODAY} rcur00000001,rcur00000002`);
  expect(render().result.current.answered).toEqual(new Set(['rcur00000001', 'rcur00000002']));
  expect(render(TOMORROW).result.current.answered).toEqual(new Set());
});

it('adds an answer to the ones already given, and keeps them across a reload', () => {
  localStorage.setItem(USER_KEYS.recurringAnswered, `${TODAY} rcur00000001`);
  const { result, unmount } = render();
  act(() => result.current.answer(['rcur00000002']));
  expect(result.current.answered).toEqual(new Set(['rcur00000001', 'rcur00000002']));
  act(() => result.current.answer(['rcur00000003', 'rcur00000001']));
  expect(result.current.answered).toEqual(new Set(['rcur00000001', 'rcur00000002', 'rcur00000003']));
  unmount();
  expect(render().result.current.answered).toEqual(new Set(['rcur00000001', 'rcur00000002', 'rcur00000003']));
});

it("starts a new day with none, and drops the day before's once it answers", () => {
  const { result, rerender } = render();
  act(() => result.current.answer(['rcur00000001']));
  rerender({ today: TOMORROW });
  expect(result.current.answered).toEqual(new Set());
  act(() => result.current.answer(['rcur00000002']));
  expect(result.current.answered).toEqual(new Set(['rcur00000002']));
  expect(localStorage.getItem(USER_KEYS.recurringAnswered)).toBe(`${TOMORROW} rcur00000002`);
});

it('keeps the answers another tab of this browser gave since this one read them', () => {
  const first = render();
  const second = render();
  act(() => first.result.current.answer(['rcur00000001', 'rcur00000002']));
  // The second tab read nothing at mount and still shows nothing answered; its answer adds to what is stored.
  act(() => second.result.current.answer(['rcur00000003']));
  expect(second.result.current.answered).toEqual(new Set(['rcur00000001', 'rcur00000002', 'rcur00000003']));
  expect(render().result.current.answered).toEqual(new Set(['rcur00000001', 'rcur00000002', 'rcur00000003']));
});
