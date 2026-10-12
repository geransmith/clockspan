// @vitest-environment happy-dom
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { SettingsProvider } from '../hooks/useSettings';
import { CONFIRM, MEETING_ENDS_FIRST, WEEKLY_MEETINGS_FULL } from '../lib/copy';
import { answered, makeSettings, settle, T0, TODAY } from '../test/hooks';
import { atTime } from '../../../shared/dates.js';
import { WEEKLY_MEETINGS_MAX } from '../../../shared/settings.js';
import type { Day, Meeting, Settings, WeeklyMeeting } from '../types';
import { Meetings } from './Meetings';

vi.mock('../api');

const at = (hour: number, minute: number) => atTime(TODAY, hour, minute);
const STANDUP = { title: 'Standup', startsAt: at(9, 30), endsAt: at(9, 45) };
const SYNC = { title: 'Team sync', startsAt: at(10, 0), endsAt: at(11, 0) };

/** The card on a stored copy that takes each save and clear, as the day store shows it. */
function Card({ initial, onSet, onClear }: { initial: Day['meetings']; onSet: (uid: string, m: Meeting | null) => void; onClear: (uid: string) => void }) {
  const [meetings, setMeetings] = useState(initial);
  return (
    <Meetings
      date={TODAY}
      today={TODAY}
      meetings={meetings}
      onSet={(uid, m) => {
        onSet(uid, m);
        setMeetings((stored) => ({ ...stored, [uid]: m }));
      }}
      onClear={(uid) => {
        onClear(uid);
        setMeetings(({ [uid]: _cleared, ...stored }) => stored);
      }}
    />
  );
}

async function renderCard(meetings: Day['meetings']) {
  const onSet = vi.fn<(uid: string, m: Meeting | null) => void>();
  const onClear = vi.fn<(uid: string) => void>();
  render(
    <SettingsProvider>
      <Card initial={meetings} onSet={onSet} onClear={onClear} />
    </SettingsProvider>,
  );
  await settle();
  return { onSet, onClear };
}

const titles = () => screen.queryAllByRole('textbox').map((b) => (b as HTMLInputElement).value);
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
/** Types a time into a field (`<label> time`), from its first segment, as `TimeField.test.tsx` does. */
function typeTime(label: string, keys: string) {
  act(() =>
    within(screen.getByRole('group', { name: `${label} time` }))
      .getAllByRole('spinbutton')[0]!
      .focus(),
  );
  for (const data of keys)
    act(() => {
      document.activeElement!.dispatchEvent(new InputEvent('beforeinput', { data, inputType: 'insertText', bubbles: true, cancelable: true }));
    });
}

// TODAY, 2026-09-28, is a Monday.
const WEEKLY: WeeklyMeeting = { uid: 'stand000', title: 'Standup', weekdays: [1, 2, 3, 4, 5], start: 570, end: 585, since: '2026-09-01', until: null };

/** The settings hold `meetings`, and each save answers what it sent, as the server stores it. */
function serveWeekly(meetings: WeeklyMeeting[]) {
  vi.mocked(api.getSettings).mockResolvedValue(answered(makeSettings({ meetings })));
  vi.mocked(api.putSettings).mockImplementation((patch) => Promise.resolve(answered(makeSettings({ meetings: patch.meetings ?? [] }))));
}
const savedWeekly = () => vi.mocked(api.putSettings).mock.lastCall?.[0].meetings;

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});

describe('Meetings', () => {
  it('lists the meetings by start, leaves out the ones taken off, and says when there are none', async () => {
    await renderCard({ b: SYNC, gone: null, a: STANDUP });
    expect(titles()).toEqual(['Standup', 'Team sync']);
    expect(screen.queryByText('No meetings on this day.')).toBeNull();
  });

  it('says when the day has no meetings', async () => {
    await renderCard({ gone: null });
    expect(screen.getByText('No meetings on this day.')).toBeTruthy();
  });

  it('saves a title on blur or Enter, trimmed, and sends nothing for one unchanged', async () => {
    const { onSet } = await renderCard({ a: STANDUP, b: SYNC });
    const standup = screen.getByRole('textbox', { name: 'Title of Standup' });
    fireEvent.change(standup, { target: { value: '  Daily standup ' } });
    fireEvent.blur(standup);
    expect(onSet).toHaveBeenCalledExactlyOnceWith('a', { ...STANDUP, title: 'Daily standup' });
    const sync = screen.getByRole('textbox', { name: 'Title of Team sync' });
    fireEvent.change(sync, { target: { value: 'Team sync ' } });
    fireEvent.keyDown(sync, { key: 'Enter' });
    expect(onSet).toHaveBeenCalledOnce();
    expect((sync as HTMLInputElement).value).toBe('Team sync');
  });

  it('moves a meeting by its start, keeping its length, and refuses an end at or before the start', async () => {
    // A filled field saves on every key, as a punch row does: the last save is the time typed.
    const { onSet } = await renderCard({ a: STANDUP });
    typeTime('Standup start', '1000');
    expect(onSet).toHaveBeenLastCalledWith('a', { ...STANDUP, startsAt: at(10, 0), endsAt: at(10, 15) });
    typeTime('Standup end', '1000');
    expect(screen.getByRole('alert').textContent).toBe(MEETING_ENDS_FIRST);
    expect(onSet.mock.calls.every(([, m]) => m != null && m.endsAt > m.startsAt)).toBe(true);
    typeTime('Standup end', '1100');
    expect(onSet).toHaveBeenLastCalledWith('a', { ...STANDUP, startsAt: at(10, 0), endsAt: at(11, 0) });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('names a meeting with no title by its start', async () => {
    await renderCard({ a: { ...STANDUP, title: '' } });
    expect(button('Remove Meeting at 9:30 AM')).toBeTruthy();
  });

  it('takes a meeting off the day with ×, handing the focus to the next ×, and the last one to Add Meeting', async () => {
    const { onClear } = await renderCard({ a: STANDUP, b: SYNC });
    fireEvent.click(button('Remove Standup'));
    expect(onClear).toHaveBeenCalledExactlyOnceWith('a');
    expect(document.activeElement).toBe(button('Remove Team sync'));
    fireEvent.click(button('Remove Team sync'));
    expect(onClear).toHaveBeenLastCalledWith('b');
    expect(document.activeElement).toBe(button('Add Meeting'));
  });

  it('adds a meeting: the title box takes the focus, a start fills a 30-minute end, and Add sends it under a new uid', async () => {
    const { onSet } = await renderCard({});
    fireEvent.click(button('Add Meeting'));
    const title = screen.getByRole('textbox', { name: 'Title' });
    expect(document.activeElement).toBe(title);
    expect(button('Add').disabled).toBe(true);
    fireEvent.change(title, { target: { value: '  Customer call ' } });
    typeTime('Start', '200');
    fireEvent.click(button('Add'));
    expect(onSet).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^[0-9a-f]{32}$/), {
      title: 'Customer call',
      startsAt: at(14, 0),
      endsAt: at(14, 30),
    });
    expect(screen.queryByRole('group', { name: 'New meeting' })).toBeNull();
    expect(document.activeElement).toBe(button('Add Meeting'));
  });

  it("keeps a new meeting's end 30 minutes after its start, as each key saves, until the end is typed", async () => {
    const { onSet } = await renderCard({});
    fireEvent.click(button('Add Meeting'));
    typeTime('Start', '930');
    fireEvent.click(button('Add'));
    expect(onSet).toHaveBeenLastCalledWith(expect.any(String), { title: '', startsAt: at(9, 30), endsAt: at(10, 0) });
    fireEvent.click(button('Add Meeting'));
    typeTime('Start', '930');
    typeTime('End', '1100');
    typeTime('Start', '915');
    fireEvent.click(button('Add'));
    expect(onSet).toHaveBeenLastCalledWith(expect.any(String), { title: '', startsAt: at(9, 15), endsAt: at(11, 0) });
  });

  it('refuses a new meeting that ends before it starts, and closes on Escape or Cancel', async () => {
    const { onSet } = await renderCard({});
    fireEvent.click(button('Add Meeting'));
    typeTime('Start', '200');
    typeTime('End', '1200');
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Title' }), { key: 'Enter' });
    expect(screen.getByRole('alert').textContent).toBe(MEETING_ENDS_FIRST);
    expect(onSet).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Title' }), { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'New meeting' })).toBeNull();
    expect(document.activeElement).toBe(button('Add Meeting'));
    fireEvent.click(button('Add Meeting'));
    fireEvent.click(button('Cancel'));
    expect(screen.queryByRole('group', { name: 'New meeting' })).toBeNull();
  });

  it('skips a weekly meeting on this day with ×, Put Back taking the focus, and puts it back at its usual times', async () => {
    serveWeekly([WEEKLY]);
    const { onSet, onClear } = await renderCard({});
    expect(titles()).toEqual(['Standup']);
    fireEvent.click(button('Skip Standup on this day'));
    expect(onSet).toHaveBeenCalledExactlyOnceWith('stand000', null);
    expect(screen.getByText('skipped')).toBeTruthy();
    expect(document.activeElement).toBe(button('Put back Standup'));
    fireEvent.click(button('Put back Standup'));
    expect(onClear).toHaveBeenCalledExactlyOnceWith('stand000');
    expect(document.activeElement).toBe(button('Skip Standup on this day'));
  });

  it('moves a weekly meeting on this day only, and renames it on every day', async () => {
    serveWeekly([WEEKLY]);
    const { onSet } = await renderCard({});
    typeTime('Standup start', '1000');
    expect(onSet).toHaveBeenLastCalledWith('stand000', { title: null, startsAt: at(10, 0), endsAt: at(10, 15) });
    const title = screen.getByRole('textbox', { name: 'Title of Standup' });
    fireEvent.change(title, { target: { value: 'Daily standup' } });
    fireEvent.blur(title);
    await settle();
    expect(savedWeekly()).toEqual([{ ...WEEKLY, title: 'Daily standup' }]);
    expect(onSet.mock.calls.every(([, m]) => m?.title === null)).toBe(true);
  });

  it('opens its days and usual time, which change it from today on, and Stop Repeating asks first', async () => {
    serveWeekly([WEEKLY]);
    await renderCard({});
    const days = button('Standup repeats Mon–Fri');
    fireEvent.click(days);
    expect(days.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(button('Friday'));
    await settle();
    const ended = { ...WEEKLY, until: '2026-09-27' };
    expect(savedWeekly()).toEqual([ended, { ...WEEKLY, weekdays: [1, 2, 3, 4], since: TODAY }]);
    expect(button('Standup repeats Mon–Thu').getAttribute('aria-expanded')).toBe('true');
    typeTime('Standup usual start', '1000');
    await settle();
    expect(savedWeekly()).toEqual([ended, { ...WEEKLY, weekdays: [1, 2, 3, 4], since: TODAY, start: 600, end: 615 }]);
    typeTime('Standup usual end', '1000');
    expect(screen.getByRole('alert').textContent).toBe(MEETING_ENDS_FIRST);

    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal('confirm', confirm);
    const saves = vi.mocked(api.putSettings).mock.calls.length;
    fireEvent.click(button('Stop Repeating'));
    expect(confirm).toHaveBeenLastCalledWith(CONFIRM.stopMeeting('Standup'));
    expect(vi.mocked(api.putSettings).mock.calls.length).toBe(saves);
    fireEvent.click(button('Stop Repeating'));
    await settle();
    expect(savedWeekly()).toEqual([ended]);
    expect(titles()).toEqual([]);
    expect(document.activeElement).toBe(button('Add Meeting'));
  });

  it('adds a weekly meeting when days are pressed, and none past the cap', async () => {
    serveWeekly([]);
    const { onSet } = await renderCard({});
    fireEvent.click(button('Add Meeting'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Team sync' } });
    typeTime('Start', '200');
    fireEvent.click(button('Monday'));
    fireEvent.click(button('Thursday'));
    fireEvent.click(button('Monday'));
    fireEvent.click(button('Tuesday'));
    fireEvent.click(button('Add'));
    await settle();
    expect(onSet).not.toHaveBeenCalled();
    const [added, ...more] = savedWeekly() ?? [];
    expect(more).toEqual([]);
    expect(added?.uid).toMatch(/^[0-9a-f]{32}$/);
    expect({ ...added, uid: '' }).toEqual({ uid: '', title: 'Team sync', weekdays: [2, 4], start: 840, end: 870, since: TODAY, until: null });
  });

  it('refuses a weekly meeting once running ones fill the cap', async () => {
    // On Sundays, so none is listed on this Monday.
    const full: Settings['meetings'] = Array.from({ length: WEEKLY_MEETINGS_MAX }, (_, i) => ({
      ...WEEKLY,
      uid: `m${String(i).padStart(7, '0')}`,
      weekdays: [7],
    }));
    serveWeekly(full);
    await renderCard({});
    fireEvent.click(button('Add Meeting'));
    typeTime('Start', '200');
    fireEvent.click(button('Monday'));
    fireEvent.click(button('Add'));
    expect(screen.getByRole('alert').textContent).toBe(WEEKLY_MEETINGS_FULL);
    expect(api.putSettings).not.toHaveBeenCalled();
  });

  it('keeps each row in its place while the focus is in the card, and sorts them again once it leaves', async () => {
    await renderCard({ a: STANDUP, b: SYNC });
    typeTime('Standup start', '1030');
    expect(titles()).toEqual(['Standup', 'Team sync']);
    expect(document.activeElement?.closest('.meeting-row')).toBe(screen.getByRole('textbox', { name: 'Title of Standup' }).closest('.meeting-row'));
    act(() => (document.activeElement as HTMLElement).blur());
    expect(titles()).toEqual(['Team sync', 'Standup']);
  });

  it("hands the focus on when a day turned off takes the row away, and when Stop Repeating does with a new meeting's row open", async () => {
    serveWeekly([WEEKLY, { ...WEEKLY, uid: 'sync0000', title: 'Sync', start: 600, end: 630 }]);
    await renderCard({});
    fireEvent.click(button('Standup repeats Mon–Fri'));
    // TODAY is a Monday.
    act(() => button('Monday').focus());
    fireEvent.click(button('Monday'));
    await settle();
    expect(titles()).toEqual(['Sync']);
    expect(document.activeElement).toBe(button('Skip Sync on this day'));

    vi.stubGlobal('confirm', () => true);
    fireEvent.click(button('Add Meeting'));
    fireEvent.click(button('Sync repeats Mon–Fri'));
    act(() => button('Stop Repeating').focus());
    fireEvent.click(button('Stop Repeating'));
    await settle();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Title' }));
  });
});
