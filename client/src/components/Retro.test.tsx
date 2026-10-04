// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { SettingsProvider } from '../hooks/useSettings';
import { RETRO_PROMPT } from '../lib/copy';
import { deferred, makeSettings, settle, T0 } from '../test/hooks';
import type { Priority } from '../types';
import { Retro } from './Retro';

vi.mock('../api');
vi.mock('../lib/alerts');

// A past day, so the "Plan tomorrow" part (today's card only) stays out of these tests.
const DATE = '2026-09-25';
const TODAY = '2026-09-28';
const PRIORITIES: Priority[] = [{ position: 1, text: 'Report', done: false, uid: 'abcdef123456', addedAt: T0 }];

async function renderCard(note = '', reviewedAt: number | null = null, priorities = PRIORITIES) {
  const onChange = vi.fn<(patch: api.RetroPatch) => Promise<boolean>>(() => Promise.resolve(true));
  const card = (n: string, r: number | null) => (
    <SettingsProvider>
      <Retro date={DATE} today={TODAY} priorities={priorities} sessions={[]} note={n} reviewedAt={r} onChange={onChange} />
    </SettingsProvider>
  );
  const view = render(card(note, reviewedAt));
  await settle();
  return {
    ...view,
    onChange,
    again: (n: string, r: number | null = null) => view.rerender(card(n, r)),
    box: screen.getByPlaceholderText(RETRO_PROMPT) as HTMLTextAreaElement,
  };
}

const markReviewed = () => fireEvent.click(screen.getByRole('button', { name: /Mark reviewed/ }));

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  vi.mocked(api.getSettings).mockResolvedValue(makeSettings());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('Retro', () => {
  it('saves the note 800 ms after typing stops, once', async () => {
    const { box, onChange } = await renderCard();
    fireEvent.change(box, { target: { value: 'Meetings' } });
    await settle(799);
    expect(onChange).not.toHaveBeenCalled();
    await settle(1);
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ note: 'Meetings' });
    fireEvent.blur(box);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('saves on leaving the box, a note put back as it was too', async () => {
    const { box, onChange } = await renderCard('Kept');
    fireEvent.change(box, { target: { value: 'Kept, and more' } });
    fireEvent.blur(box);
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ note: 'Kept, and more' });

    onChange.mockClear();
    fireEvent.change(box, { target: { value: 'Kept' } });
    fireEvent.blur(box);
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ note: 'Kept' });
  });

  it('still saves a note typed just before the card goes away', async () => {
    const { box, onChange, unmount } = await renderCard();
    fireEvent.change(box, { target: { value: 'Left mid-sentence' } });
    unmount();
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ note: 'Left mid-sentence' });
  });

  it('a note whose save fails stays in the box and goes again on blur', async () => {
    const { box, onChange, again } = await renderCard('Kept');
    onChange.mockResolvedValueOnce(false);
    fireEvent.change(box, { target: { value: 'Meetings ran long' } });
    again('Meetings ran long'); // the store's copy with the change on it
    await settle(800);
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ note: 'Meetings ran long' });
    again('Kept'); // the store dropped the change
    expect(box.value).toBe('Meetings ran long');
    fireEvent.blur(box);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith({ note: 'Meetings ran long' });
  });

  it('a note typed back to one whose save is still out is kept when that save fails', async () => {
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    const { box, onChange, again } = await renderCard('');
    onChange.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    fireEvent.change(box, { target: { value: 'Meetings' } });
    await settle(800);
    again('Meetings'); // the store's copy with the change on it
    fireEvent.change(box, { target: { value: 'Meetingsx' } });
    fireEvent.change(box, { target: { value: 'Meetings' } });
    await settle(800);
    expect(onChange.mock.calls).toEqual([[{ note: 'Meetings' }], [{ note: 'Meetings' }]]);
    first.resolve(false);
    await settle();
    again(''); // the store dropped the first change
    expect(box.value).toBe('Meetings');
    second.resolve(true);
    await settle();
    again('Meetings');
    expect(box.value).toBe('Meetings');
  });

  it('Mark reviewed waits for the unsaved note to save, then ticks; Undo clears it', async () => {
    const note = deferred<boolean>();
    const { box, onChange, again } = await renderCard();
    onChange.mockReturnValueOnce(note.promise);
    fireEvent.change(box, { target: { value: 'Went to plan' } });
    markReviewed();
    await settle();
    expect(onChange.mock.calls).toEqual([[{ note: 'Went to plan' }]]);
    note.resolve(true);
    await settle();
    expect(onChange.mock.calls).toEqual([[{ note: 'Went to plan' }], [{ done: true }]]);

    again('Went to plan', T0);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onChange).toHaveBeenLastCalledWith({ done: false });

    // Nothing waiting: the tick goes alone.
    onChange.mockClear();
    again('Went to plan');
    markReviewed();
    await settle();
    expect(onChange.mock.calls).toEqual([[{ done: true }]]);
  });

  it('Mark reviewed sends no tick when the note fails, and the box keeps the text', async () => {
    const { box, onChange } = await renderCard();
    onChange.mockResolvedValueOnce(false);
    fireEvent.change(box, { target: { value: 'Went to plan' } });
    markReviewed();
    await settle();
    expect(onChange.mock.calls).toEqual([[{ note: 'Went to plan' }]]);
    expect(box.value).toBe('Went to plan');
  });

  it('Mark reviewed right after the 800 ms save fired waits for that save and sends no second note', async () => {
    const note = deferred<boolean>();
    const { box, onChange } = await renderCard();
    onChange.mockReturnValueOnce(note.promise);
    fireEvent.change(box, { target: { value: 'Went to plan' } });
    await settle(800);
    markReviewed();
    await settle();
    expect(onChange.mock.calls).toEqual([[{ note: 'Went to plan' }]]);
    note.resolve(true);
    await settle();
    expect(onChange.mock.calls).toEqual([[{ note: 'Went to plan' }], [{ done: true }]]);
  });

  it('keeps the note and Mark reviewed on a day with nothing planned or logged', async () => {
    // The retro alarm stays armed until the day is reviewed, and its banner opens this card.
    const { box, onChange } = await renderCard('', null, []);
    expect(screen.getByText(/Write priorities and log a session or two/)).toBeTruthy();
    expect(screen.queryByText('On plan')).toBeNull();
    fireEvent.change(box, { target: { value: 'Sick day' } });
    markReviewed();
    await settle();
    expect(onChange.mock.calls).toEqual([[{ note: 'Sick day' }], [{ done: true }]]);
  });
});
