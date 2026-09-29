// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { settle } from '../test/hooks';
import { useDebouncedDraft } from './useDebouncedDraft';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function draftOf(stored: string) {
  const save = vi.fn<(value: string) => void>();
  const view = renderHook((props: { stored: string; save: (value: string) => void }) => useDebouncedDraft(props.stored, props.save, 400), {
    initialProps: { stored, save },
  });
  return { ...view, save, again: (next: string, s = save) => view.rerender({ stored: next, save: s }) };
}

it('shows each edit at once and saves the last one 400 ms after it, once', async () => {
  const { result, save } = draftOf('');
  act(() => result.current.edit('Wri'));
  await settle(300);
  act(() => result.current.edit('Write'));
  expect(result.current.draft).toBe('Write');
  await settle(399);
  expect(save).not.toHaveBeenCalled();
  await settle(1);
  expect(save).toHaveBeenCalledExactlyOnceWith('Write');
  // Nothing is waiting any more: leaving the field saves nothing.
  act(() => result.current.flush());
  expect(save).toHaveBeenCalledTimes(1);
});

it('saves an edit made now at once, and a flush saves the one waiting', async () => {
  const { result, save } = draftOf('Report');
  act(() => result.current.edit('Report, typed'));
  act(() => result.current.edit('Report, ticked', true));
  expect(save).toHaveBeenCalledExactlyOnceWith('Report, ticked');

  act(() => result.current.edit(''));
  act(() => result.current.flush());
  expect(save).toHaveBeenLastCalledWith('');
  await settle(400);
  expect(save).toHaveBeenCalledTimes(2);
});

it('follows the stored value while nothing waits, and keeps a draft that does', async () => {
  const { result, again } = draftOf('First');
  again('From another device');
  expect(result.current.draft).toBe('From another device');
  act(() => result.current.edit('Mine'));
  again('Newer still');
  expect(result.current.draft).toBe('Mine');
  await settle(400);
  again('After the save');
  expect(result.current.draft).toBe('After the save');
});

it('saves a waiting edit when it goes away, through the latest save', async () => {
  const { result, save, again, unmount } = draftOf('');
  act(() => result.current.edit('Left mid-sentence'));
  const newer = vi.fn<(value: string) => void>();
  again('', newer);
  unmount();
  expect(newer).toHaveBeenCalledExactlyOnceWith('Left mid-sentence');
  await settle(400);
  expect(newer).toHaveBeenCalledTimes(1);
  expect(save).not.toHaveBeenCalled();
});
