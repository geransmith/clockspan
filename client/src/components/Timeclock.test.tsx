// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { SettingsProvider } from '../hooks/useSettings';
import { playSound, unlockAudio } from '../lib/alerts';
import { addPunchPair, dayTimeclock, removePunchPair } from '../lib/timeclock';
import { answered, makeSettings, punchesAt, settle, T0, TODAY, YESTERDAY } from '../test/hooks';
import { HOUR_MS, MINUTE_MS } from '../../../shared/dates.js';
import { MAX_PUNCHES } from '../../../shared/punches.js';
import type { Punch } from '../types';
import { Timeclock } from './Timeclock';

vi.mock('../api');
vi.mock('../lib/alerts');

async function renderCard(date = TODAY, punches: Punch[] = punchesAt()) {
  const onEditingChange = vi.fn<(editing: boolean) => void>();
  const onChange = vi.fn<(punches: Punch[]) => void>();
  const card = (p: Punch[], now = T0) => (
    <SettingsProvider>
      <Timeclock
        date={date}
        isToday={date === TODAY}
        now={now}
        punches={p}
        tc={dayTimeclock({ date, punches: p, workMinutes: null }, makeSettings(), TODAY, now)}
        overtimeApproved={false}
        workMinutes={null}
        week={null}
        focus={{ seconds: 0, count: 0 }}
        onChange={onChange}
        onOvertimeChange={vi.fn()}
        onWorkMinutesChange={vi.fn()}
        onEditingChange={onEditingChange}
        orderNotice="order"
      />
    </SettingsProvider>
  );
  const view = render(card(punches));
  await settle();
  return { ...view, onEditingChange, onChange, again: (p: Punch[], now?: number) => view.rerender(card(p, now)) };
}

/** A segment of the row's time field, where typing a time starts. */
const field = (label: string) => within(screen.getByRole('group', { name: `${label} time` })).getAllByRole('spinbutton')[0]!;
const nowButton = () => screen.getByRole('button', { name: 'Now: Clock in' });
const labels = () => [...document.querySelectorAll('.punch-label')].map((l) => l.textContent);
const focus = (el: HTMLElement) => act(() => el.focus());

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  vi.mocked(api.getSettings).mockResolvedValue(answered(makeSettings()));
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

  it('keeps a pair in its place while its Out is typed across lunch, and moves it once the focus leaves', async () => {
    // Clocked in at 6:00, out for lunch at 8:00, then "Add extra out / in": the empty Out sits after lunch.
    const withPair = addPunchPair(punchesAt(T0 - 3 * HOUR_MS, T0 - HOUR_MS));
    const { again } = await renderCard(TODAY, withPair);
    const out = field('Out 1');
    focus(out);
    // 7:00 typed (or a time on its way to another): before lunch, but the field being typed in stays put.
    again(withPair.map((p) => (p.position === 3 ? { ...p, at: T0 - 2 * HOUR_MS } : p)));
    expect(document.activeElement).toBe(out);
    expect(labels()).toEqual(['Clock in', 'Lunch out', 'Lunch in', 'Out 1', 'In 1', 'Clock out']);
    focus(field('Clock in'));
    expect(labels()).toEqual(['Clock in', 'Out 1', 'In 1', 'Lunch out', 'Lunch in', 'Clock out']);
  });

  it("celebrates a Clock out set on this card, though the save's answer brings another device's change", async () => {
    const day = punchesAt(T0 - 8 * HOUR_MS, T0 - 5 * HOUR_MS, T0 - 4.5 * HOUR_MS);
    const { onChange, again } = await renderCard(TODAY, day);
    fireEvent.click(screen.getByRole('button', { name: 'Now: Clock out' }));
    const sent = onChange.mock.lastCall![0];
    again(sent.map((p) => (p.position === 2 ? { ...p, at: T0 - 4 * HOUR_MS } : p)));
    expect(playSound).toHaveBeenCalledOnce();
  });

  it('celebrates the clock reaching a Clock out typed ahead', async () => {
    const day = punchesAt(T0 - 8 * HOUR_MS, T0 - 5 * HOUR_MS, T0 - 4.5 * HOUR_MS, T0 + 10 * MINUTE_MS);
    const { again } = await renderCard(TODAY, day);
    again(day, T0 + 10 * MINUTE_MS);
    expect(playSound).toHaveBeenCalledOnce();
  });

  it("doesn't celebrate a Clock out another device set, which a refresh brings", async () => {
    const day = punchesAt(T0 - 8 * HOUR_MS, T0 - 5 * HOUR_MS, T0 - 4.5 * HOUR_MS);
    const { again } = await renderCard(TODAY, day);
    again(punchesAt(T0 - 8 * HOUR_MS, T0 - 5 * HOUR_MS, T0 - 4.5 * HOUR_MS, T0));
    expect(screen.getByRole('status').textContent).toMatch(/Day complete/);
    expect(playSound).not.toHaveBeenCalled();
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

  it('gives the focus to Add extra out / in once Remove takes its pair away', async () => {
    const { onChange, again } = await renderCard(TODAY, addPunchPair(punchesAt(T0 - HOUR_MS)));
    const remove = screen.getByRole('button', { name: 'Remove Out 1 / In 1' });
    focus(remove);
    fireEvent.click(remove);
    again(onChange.mock.lastCall![0]);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add extra out / in' }));
  });

  it("gives the focus to the new pair's Remove when its Add reaches the row cap", async () => {
    const { onChange, again } = await renderCard(TODAY, punchesAt(...Array<null>(MAX_PUNCHES - 2).fill(null)));
    const add = screen.getByRole('button', { name: 'Add extra out / in' });
    focus(add);
    fireEvent.click(add);
    again(onChange.mock.lastCall![0]);
    expect(screen.queryByRole('button', { name: 'Add extra out / in' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove Out 18 / In 18' }));
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
