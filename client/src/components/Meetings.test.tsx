// @vitest-environment happy-dom
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsProvider } from '../hooks/useSettings';
import { MEETING_ENDS_FIRST } from '../lib/copy';
import { settle, T0, TODAY } from '../test/hooks';
import { atTime } from '../../../shared/dates.js';
import type { Day, Meeting } from '../types';
import { Meetings } from './Meetings';

vi.mock('../api');

const at = (hour: number, minute: number) => atTime(TODAY, hour, minute);
const STANDUP = { title: 'Standup', startsAt: at(9, 30), endsAt: at(9, 45) };
const SYNC = { title: 'Team sync', startsAt: at(10, 0), endsAt: at(11, 0) };

/** The card on a stored copy that takes each save, as the day store shows it. */
function Card({ initial, onSet }: { initial: Day['meetings']; onSet: (uid: string, m: Meeting | null) => void }) {
  const [meetings, setMeetings] = useState(initial);
  return (
    <Meetings
      date={TODAY}
      meetings={meetings}
      onSet={(uid, m) => {
        onSet(uid, m);
        setMeetings((stored) => ({ ...stored, [uid]: m }));
      }}
    />
  );
}

async function renderCard(meetings: Day['meetings']) {
  const onSet = vi.fn<(uid: string, m: Meeting | null) => void>();
  render(
    <SettingsProvider>
      <Card initial={meetings} onSet={onSet} />
    </SettingsProvider>,
  );
  await settle();
  return { onSet };
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
    const { onSet } = await renderCard({ a: STANDUP, b: SYNC });
    fireEvent.click(button('Remove Standup'));
    expect(onSet).toHaveBeenCalledExactlyOnceWith('a', null);
    expect(document.activeElement).toBe(button('Remove Team sync'));
    fireEvent.click(button('Remove Team sync'));
    expect(onSet).toHaveBeenLastCalledWith('b', null);
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
});
