// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { SettingsProvider } from '../hooks/useSettings';
import { PLAN_NEXT, RETRO_PROMPT } from '../lib/copy';
import { completedSession, deferred, makePriority, makeSettings, settle, T0, TODAY } from '../test/hooks';
import type { Priority, Session } from '../types';
import { Retro } from './Retro';

vi.mock('../api');
vi.mock('../lib/alerts');

// A past day, so the "Plan tomorrow" part (today's card only) stays out of these tests.
const DATE = '2026-09-25';
const PRIORITIES: Priority[] = [makePriority(1, 'Report', { uid: 'abcdef123456' })];

async function renderCard(note = '', reviewedAt: number | null = null, priorities = PRIORITIES, date = DATE, sessions: Session[] = []) {
  const onChange = vi.fn<(patch: api.RetroPatch) => Promise<boolean>>(() => Promise.resolve(true));
  const card = (n: string, r: number | null) => (
    <SettingsProvider>
      <Retro date={date} today={TODAY} priorities={priorities} sessions={sessions} note={n} reviewedAt={r} pick={null} onChange={onChange} />
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

describe('Retro', () => {
  it("offers the next day's plan on today's card only", async () => {
    await renderCard();
    expect(screen.queryByRole('button', { name: PLAN_NEXT.open('tomorrow') })).toBeNull();
    cleanup();
    await renderCard('', null, PRIORITIES, TODAY);
    expect(screen.getByRole('button', { name: PLAN_NEXT.open('tomorrow') })).toBeTruthy();
  });

  it("counts the routines among the day's rows and on their own, and leaves them out of a day with none", async () => {
    await renderCard('', null, [
      makePriority(1, 'Report', { done: true }),
      makePriority(2, 'Invoices'),
      makePriority(3, 'Monitor the queue', { uid: 'rcur00000001', recurring: true, done: true }),
      makePriority(4, 'Follow-ups', { uid: 'rcur00000002', recurring: true }),
    ]);
    expect(screen.getByText('Planned').querySelector('.muted')?.textContent).toBe('2 of 4 done · routines 1 of 2');
    cleanup();
    await renderCard();
    expect(screen.getByText('Planned').querySelector('.muted')?.textContent).toBe('0 of 1 done');
  });

  it("names each session not on the plan by its task's current name, else its label", async () => {
    const sessions = [
      completedSession(1, T0, 600, { label: 'Inbox' }),
      completedSession(2, T0 + 1, 600, { label: 'Started as this', priorityUid: 'leftday00001', title: 'Left the day' }),
      completedSession(3, T0 + 2, 600, { priorityUid: 'abcdef123456', title: 'Report' }),
    ];
    await renderCard('', null, PRIORITIES, DATE, sessions);
    const section = screen.getByText('Not on the plan').closest('section')!;
    expect([...section.querySelectorAll('.retro-text')].map((el) => el.firstChild!.textContent)).toEqual(['Inbox', 'Left the day']);
  });

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
