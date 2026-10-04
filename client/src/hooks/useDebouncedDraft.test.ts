// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deferred, settle } from '../test/hooks';
import { useDebouncedDraft } from './useDebouncedDraft';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function draftOf(stored: string) {
  const save = vi.fn<(value: string) => boolean | Promise<boolean>>(() => true);
  const view = renderHook(
    (props: { stored: string; save: (value: string) => boolean | Promise<boolean> }) => useDebouncedDraft(props.stored, props.save, 400),
    { initialProps: { stored, save } },
  );
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
  await act(() => result.current.flush());
  expect(save).toHaveBeenCalledTimes(1);
});

it('saves an edit made now at once, and a flush saves the one waiting', async () => {
  const { result, save } = draftOf('Report');
  act(() => result.current.edit('Report, typed'));
  act(() => result.current.edit('Report, ticked', true));
  expect(save).toHaveBeenCalledExactlyOnceWith('Report, ticked');

  act(() => result.current.edit(''));
  await act(() => result.current.flush());
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
  const newer = vi.fn<(value: string) => boolean | Promise<boolean>>(() => true);
  again('', newer);
  unmount();
  expect(newer).toHaveBeenCalledExactlyOnceWith('Left mid-sentence');
  await settle(400);
  expect(newer).toHaveBeenCalledTimes(1);
  expect(save).not.toHaveBeenCalled();
});

it('keeps the text when its save answers false, and the next flush sends it again', async () => {
  const { result, save, again } = draftOf('Stored');
  save.mockReturnValueOnce(Promise.resolve(false));
  act(() => result.current.edit('Typed'));
  again('Typed'); // the store's copy with the change on it
  await settle(400);
  expect(save).toHaveBeenCalledExactlyOnceWith('Typed');
  again('Stored'); // the store dropped the change
  expect(result.current.draft).toBe('Typed');

  await expect(act(() => result.current.flush())).resolves.toBe(true);
  expect(save).toHaveBeenCalledTimes(2);
  expect(save).toHaveBeenLastCalledWith('Typed');
  // Saved, so the draft follows the stored value again.
  again('From another device');
  expect(result.current.draft).toBe('From another device');
});

it('a flush while the save is out sends nothing more and resolves with its answer', async () => {
  const answer = deferred<boolean>();
  const { result, save } = draftOf('');
  save.mockReturnValueOnce(answer.promise);
  act(() => result.current.edit('Typed', true));
  const second = result.current.flush();
  expect(save).toHaveBeenCalledOnce();
  answer.resolve(false);
  await expect(act(() => second)).resolves.toBe(false);
  expect(save).toHaveBeenCalledOnce();
});

it.each([true, false])('an edit made while a save is out is kept whatever that save answers (%s)', async (ok) => {
  const answer = deferred<boolean>();
  const { result, save, again } = draftOf('');
  save.mockReturnValueOnce(answer.promise);
  act(() => result.current.edit('First', true));
  act(() => result.current.edit('First, and more'));
  answer.resolve(ok);
  await settle();
  again('From the store');
  expect(result.current.draft).toBe('First, and more');
  await settle(400);
  expect(save.mock.calls).toEqual([['First'], ['First, and more']]);
});

it('flush with nothing waiting resolves true', async () => {
  const { result, save } = draftOf('Stored');
  await expect(act(() => result.current.flush())).resolves.toBe(true);
  expect(save).not.toHaveBeenCalled();
});
