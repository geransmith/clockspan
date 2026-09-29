// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { SettingsProvider } from '../hooks/useSettings';
import { RETRO_PROMPT } from '../lib/copy';
import { makeSettings, settle, T0 } from '../test/hooks';
import type { Priority } from '../types';
import { Retro } from './Retro';

vi.mock('../api');
vi.mock('../lib/alerts');

// A past day, so the "Plan tomorrow" part (today's card only) stays out of these tests.
const DATE = '2026-09-25';
const TODAY = '2026-09-28';
const PRIORITIES: Priority[] = [{ position: 1, text: 'Report', done: false, uid: 'abcdef123456', addedAt: T0 }];

async function renderCard(note = '', reviewedAt: number | null = null, priorities = PRIORITIES) {
  const onChange = vi.fn<(patch: { note?: string; done?: boolean }) => void>();
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

  it('saves on leaving the box, and not at all for a note put back as it was', async () => {
    const { box, onChange } = await renderCard('Kept');
    fireEvent.change(box, { target: { value: 'Kept, and more' } });
    fireEvent.blur(box);
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ note: 'Kept, and more' });

    onChange.mockClear();
    fireEvent.change(box, { target: { value: 'Kept' } });
    fireEvent.blur(box);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('still saves a note typed just before the card goes away', async () => {
    const { box, onChange, unmount } = await renderCard();
    fireEvent.change(box, { target: { value: 'Left mid-sentence' } });
    unmount();
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ note: 'Left mid-sentence' });
  });

  it('Mark reviewed saves the unsaved note first, then the tick; Undo clears it', async () => {
    const { box, onChange, again } = await renderCard();
    fireEvent.change(box, { target: { value: 'Went to plan' } });
    fireEvent.click(screen.getByRole('button', { name: /Mark reviewed/ }));
    expect(onChange.mock.calls).toEqual([[{ note: 'Went to plan' }], [{ done: true }]]);

    again('Went to plan', T0);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onChange).toHaveBeenLastCalledWith({ done: false });
  });

  it('keeps the note and Mark reviewed on a day with nothing planned or logged', async () => {
    // The retro alarm stays armed until the day is reviewed, and its banner opens this card.
    const { box, onChange } = await renderCard('', null, []);
    expect(screen.getByText(/Write priorities and log a session or two/)).toBeTruthy();
    expect(screen.queryByText('On plan')).toBeNull();
    fireEvent.change(box, { target: { value: 'Sick day' } });
    fireEvent.click(screen.getByRole('button', { name: /Mark reviewed/ }));
    expect(onChange.mock.calls).toEqual([[{ note: 'Sick day' }], [{ done: true }]]);
  });

  it('takes the stored note while nothing is being typed, and keeps a draft that is', async () => {
    const { box, again } = await renderCard('First');
    again('From another device');
    expect(box.value).toBe('From another device');
    fireEvent.change(box, { target: { value: 'Mine' } });
    again('Newer still');
    expect(box.value).toBe('Mine');
  });
});
