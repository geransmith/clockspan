// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { useLastTab } from './useLastTab';

type Tab = 'one' | 'two' | 'three';
const KEY = 'focus:test-tab';
const ALL: { id: Tab }[] = [{ id: 'one' }, { id: 'two' }, { id: 'three' }];

const render = (tabs = ALL) => renderHook(() => useLastTab<Tab>(KEY, tabs, 'one'));

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

it('opens on the fallback with nothing stored', () => {
  expect(render().result.current[0]).toBe('one');
  expect(localStorage.getItem(KEY)).toBe('one');
});

it('remembers the tab picked, and opens on it next time', () => {
  const first = render();
  act(() => first.result.current[1]('three'));
  expect(first.result.current[0]).toBe('three');
  expect(localStorage.getItem(KEY)).toBe('three');
  first.unmount();
  expect(render().result.current[0]).toBe('three');
});

it("opens on the fallback when the stored tab isn't offered now", () => {
  localStorage.setItem(KEY, 'three');
  expect(render(ALL.slice(0, 2)).result.current[0]).toBe('one');
  localStorage.setItem(KEY, 'not a tab');
  expect(render().result.current[0]).toBe('one');
});
