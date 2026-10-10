// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { deferred, settle } from '../test/hooks';
import { useDebouncedDraft } from './useDebouncedDraft';

beforeEach(() => {
  vi.useFakeTimers();
});

type Save = (value: string, base: string) => boolean | Promise<boolean>;

function draftOf(stored: string) {
  const save = vi.fn<Save>(() => true);
  const view = renderHook((props: { stored: string; save: Save }) => useDebouncedDraft(props.stored, props.save, 400), { initialProps: { stored, save } });
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
  expect(save).toHaveBeenCalledExactlyOnceWith('Write', '');
  // Nothing is waiting any more: leaving the field saves nothing.
  await act(() => result.current.flush());
  expect(save).toHaveBeenCalledTimes(1);
});

it('saves an edit made now at once, and a flush saves the one waiting', async () => {
  const { result, save } = draftOf('Report');
  act(() => result.current.edit('Report, typed'));
  act(() => result.current.edit('Report, ticked', true));
  expect(save).toHaveBeenCalledExactlyOnceWith('Report, ticked', 'Report');

  act(() => result.current.edit(''));
  await act(() => result.current.flush());
  expect(save).toHaveBeenLastCalledWith('', 'Report');
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
  const newer = vi.fn<Save>(() => true);
  again('', newer);
  unmount();
  expect(newer).toHaveBeenCalledExactlyOnceWith('Left mid-sentence', '');
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
  expect(save).toHaveBeenCalledExactlyOnceWith('Typed', 'Stored');
  again('Stored'); // the store dropped the change
  expect(result.current.draft).toBe('Typed');

  await expect(act(() => result.current.flush())).resolves.toBe(true);
  expect(save).toHaveBeenCalledTimes(2);
  expect(save).toHaveBeenLastCalledWith('Typed', 'Stored');
  // Saved, so the draft follows the stored value again.
  again('From another device');
  expect(result.current.draft).toBe('From another device');
});

it('starts from a kept draft as an edit not saved yet, on the stored value, until a flush saves it', async () => {
  const save = vi.fn<Save>(() => true);
  const { result, rerender } = renderHook((stored: string) => useDebouncedDraft(stored, save, 400, 'Typed before'), { initialProps: 'Stored' });
  expect(result.current.draft).toBe('Typed before');
  rerender('Stored again');
  expect(result.current.draft).toBe('Typed before');
  await settle(400);
  expect(save).not.toHaveBeenCalled();
  await expect(act(() => result.current.flush())).resolves.toBe(true);
  expect(save).toHaveBeenCalledExactlyOnceWith('Typed before', 'Stored');
});

it('takes up a kept draft that arrives while nothing waits as an edit not saved yet, on the value stored then', async () => {
  const save = vi.fn<Save>(() => true);
  const initialProps: { stored: string; kept?: string } = { stored: 'Typed before' };
  const { result, rerender } = renderHook((props) => useDebouncedDraft(props.stored, save, 400, props.kept), { initialProps });
  // The earlier draft's save failed: the store's copy is back, and the text kept.
  rerender({ stored: 'Stored', kept: 'Typed before' });
  expect(result.current.draft).toBe('Typed before');
  rerender({ stored: 'From another device', kept: 'Typed before' });
  expect(result.current.draft).toBe('Typed before');
  await expect(act(() => result.current.flush())).resolves.toBe(true);
  expect(save).toHaveBeenCalledExactlyOnceWith('Typed before', 'Stored');
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
  // Saved, the first edit is what the second was made on; refused, the second carries it too.
  expect(save.mock.calls).toEqual([
    ['First', ''],
    ['First, and more', ok ? 'First' : ''],
  ]);
});

it('saves an edit made after a save with the value saved as its base, before the stored value catches up', async () => {
  const { result, save } = draftOf('Stored');
  act(() => result.current.edit('Ticked', true));
  await settle();
  // Back to how it was: a change from the value saved, though it matches the stored value.
  act(() => result.current.edit('Stored', true));
  expect(save.mock.calls).toEqual([
    ['Ticked', 'Stored'],
    ['Stored', 'Ticked'],
  ]);
});

it('builds an edit made before a value it took up has rendered on the draft the edit was made on', () => {
  const save = vi.fn<Save>(() => true);
  const { rerender } = renderHook(
    ({ stored }) => {
      const draft = useDebouncedDraft(stored, save, 400);
      // Runs after the hook's effect that takes `stored` up and before the draft it set renders:
      // a tap landing in that gap, building on the draft it sees.
      const { draft: shown, edit } = draft;
      useEffect(() => {
        if (stored === 'From another device' && shown === 'Stored') edit(`${shown}, typed`, true);
      }, [stored, shown, edit]);
      return draft;
    },
    { initialProps: { stored: 'Stored' } },
  );
  rerender({ stored: 'From another device' });
  expect(save).toHaveBeenCalledExactlyOnceWith('Stored, typed', 'Stored');
});

it('saves each edit with the stored value it last took up as its base, until it takes up another', async () => {
  const { result, save, again } = draftOf('Stored');
  act(() => result.current.edit('Typed'));
  // Not taken up while an edit waits: the edit was made on 'Stored'.
  again('From another device');
  act(() => result.current.edit('Typed more'));
  await settle(400);
  expect(save).toHaveBeenCalledExactlyOnceWith('Typed more', 'Stored');
  again('Saved');
  expect(result.current.draft).toBe('Saved');
  act(() => result.current.edit('Saved, then edited', true));
  expect(save).toHaveBeenLastCalledWith('Saved, then edited', 'Saved');
});

it('flush with nothing waiting resolves true', async () => {
  const { result, save } = draftOf('Stored');
  await expect(act(() => result.current.flush())).resolves.toBe(true);
  expect(save).not.toHaveBeenCalled();
});
