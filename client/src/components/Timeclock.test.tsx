// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { SettingsProvider } from '../hooks/useSettings';
import { unlockAudio } from '../lib/alerts';
import { addPunchPair, dayTimeclock, removePunchPair } from '../lib/timeclock';
import { makeSettings, punchesAt, settle, T0, TODAY, YESTERDAY } from '../test/hooks';
import { HOUR_MS } from '../../../shared/dates.js';
import { MAX_PUNCHES } from '../../../shared/punches.js';
import type { Punch } from '../types';
import { Timeclock } from './Timeclock';

vi.mock('../api');
vi.mock('../lib/alerts');

async function renderCard(date = TODAY, punches: Punch[] = punchesAt()) {
  const onEditingChange = vi.fn<(editing: boolean) => void>();
  const onChange = vi.fn<(punches: Punch[]) => void>();
  const card = (p: Punch[]) => (
    <SettingsProvider>
      <Timeclock
        date={date}
        isToday={date === TODAY}
        now={T0}
        punches={p}
        tc={dayTimeclock({ date, punches: p, workMinutes: null }, makeSettings(), TODAY, T0)}
        overtimeApproved={false}
        workMinutes={null}
        week={null}
        focus={{ seconds: 0, count: 0 }}
        onChange={onChange}
        onOvertimeChange={vi.fn()}
        onWorkMinutesChange={vi.fn()}
        onEditingChange={onEditingChange}
      />
    </SettingsProvider>
  );
  const view = render(card(punches));
  await settle();
  return { ...view, onEditingChange, onChange, again: (p: Punch[]) => view.rerender(card(p)) };
}

/** A segment of the row's time field, where typing a time starts. */
const field = (label: string) => within(screen.getByRole('group', { name: `${label} time` })).getAllByRole('spinbutton')[0]!;
const nowButton = () => screen.getByRole('button', { name: 'Now: Clock in' });
const focus = (el: HTMLElement) => act(() => el.focus());

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  vi.mocked(api.getSettings).mockResolvedValue(makeSettings());
});

describe('Timeclock', () => {
  it("holds today's alarms while a time field has focus, and not for the buttons beside it", async () => {
    const { onEditingChange } = await renderCard();
    focus(nowButton());
    expect(onEditingChange).not.toHaveBeenCalled();
    focus(field('Clock in'));
    expect(onEditingChange).toHaveBeenLastCalledWith(true);
    focus(nowButton());
    expect(onEditingChange).toHaveBeenLastCalledWith(false);
  });

  it('lets the hold go when the card unmounts with a time field focused', async () => {
    const { onEditingChange, unmount } = await renderCard();
    focus(field('Clock in'));
    expect(onEditingChange).toHaveBeenLastCalledWith(true);
    unmount();
    expect(onEditingChange).toHaveBeenLastCalledWith(false);
  });

  it("lets the hold go when the focused field's pair is removed", async () => {
    const punches = addPunchPair(punchesAt());
    const { onEditingChange, again } = await renderCard(TODAY, punches);
    focus(field('Out 1'));
    expect(onEditingChange).toHaveBeenLastCalledWith(true);
    // Another device removed the pair: the focused field goes with it, and no blur is sent.
    again(removePunchPair(punches, 3));
    expect(onEditingChange).toHaveBeenLastCalledWith(false);
  });

  it("never holds today's alarms from another day's sheet", async () => {
    const { onEditingChange } = await renderCard(YESTERDAY);
    focus(field('Clock in'));
    expect(onEditingChange).not.toHaveBeenCalled();
  });

  it('undoes an Add removed before any punch changes', async () => {
    // Clocked out at 9:00, then "Add extra out / in": removing that pair gives the Clock out its 9:00 back.
    const day = punchesAt(T0 - HOUR_MS, null, null, T0);
    const { onChange, again } = await renderCard(TODAY, day);
    fireEvent.click(screen.getByRole('button', { name: 'Add extra out / in' }));
    again(onChange.mock.lastCall![0]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Out 1 / In 1' }));
    expect(unlockAudio).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenLastCalledWith(day);
  });

  it('drops both rows of a pair punched after the Add', async () => {
    const clockedIn = punchesAt(T0 - HOUR_MS);
    const { onChange, again } = await renderCard(TODAY, clockedIn);
    fireEvent.click(screen.getByRole('button', { name: 'Add extra out / in' }));
    const withPair = onChange.mock.lastCall![0];
    again(withPair);
    // Out 1 punched at 9:00, here or on another device: stepping out, which must not end the day.
    again(withPair.map((p) => (p.position === 3 ? { ...p, at: T0 } : p)));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Out 1 / In 1' }));
    expect(onChange.mock.lastCall![0].map((p) => p.at)).toEqual([T0 - HOUR_MS, null, null, null]);
  });

  it('stops offering Add extra out / in at the row cap', async () => {
    const rows = (n: number) => punchesAt(...Array<null>(n).fill(null));
    await renderCard(TODAY, rows(MAX_PUNCHES - 2));
    expect(screen.getByRole('button', { name: 'Add extra out / in' })).toBeTruthy();
    cleanup();
    await renderCard(TODAY, rows(MAX_PUNCHES));
    expect(screen.queryByRole('button', { name: 'Add extra out / in' })).toBeNull();
  });

  it("shows the second meal on today's sheet only, not on a past day left clocked in", async () => {
    // Clocked in at midnight: 9 h worked by 9:00, past the 8 h day, so the second meal is in play.
    const longDay = punchesAt(T0 - 9 * HOUR_MS);
    await renderCard(TODAY, longDay);
    expect(screen.getByText(/Second meal period/)).toBeTruthy();
    cleanup();
    // Yesterday from 8:00 and never clocked out: judged at its end, 16 h in.
    await renderCard(YESTERDAY, punchesAt(T0 - 25 * HOUR_MS));
    expect(screen.queryByText(/Second meal period/)).toBeNull();
  });
});
