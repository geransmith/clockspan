// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { SettingsProvider } from '../hooks/useSettings';
import { unlockAudio } from '../lib/alerts';
import { emptyPunches, timeclockForDate } from '../lib/timeclock';
import { makeSettings, MIN, settle, T0, TODAY } from '../test/hooks';
import type { Punch } from '../types';
import { Timeclock } from './Timeclock';

vi.mock('../api');
vi.mock('../lib/alerts');

const YESTERDAY = '2026-09-27';

async function renderCard(date = TODAY, punches: Punch[] = emptyPunches()) {
  const onEditingChange = vi.fn<(editing: boolean) => void>();
  const onChange = vi.fn<(punches: Punch[]) => void>();
  const card = (p: Punch[]) => (
    <SettingsProvider>
      <Timeclock
        date={date}
        isToday={date === TODAY}
        now={T0}
        punches={p}
        tc={timeclockForDate(p, makeSettings(), date, TODAY, T0)}
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
const nowButton = () => screen.getAllByRole('button', { name: 'Now' })[0]!;
const focus = (el: HTMLElement) => act(() => el.focus());

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  vi.mocked(api.getSettings).mockResolvedValue(makeSettings());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
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

  it('lets the hold go on the next change to the punches once focus is lost with no blur', async () => {
    const { onEditingChange, again } = await renderCard();
    focus(field('Clock in'));
    expect(onEditingChange).toHaveBeenLastCalledWith(true);
    // Escape throws the draft away by remounting the field; the focused segment goes with it.
    fireEvent.keyDown(field('Clock in'), { key: 'Escape' });
    expect(document.activeElement?.closest('.timefield')).toBeFalsy();
    expect(onEditingChange).toHaveBeenLastCalledWith(true);
    // Another device punches in.
    again(emptyPunches().map((p) => ({ ...p, at: p.position === 0 ? T0 : null })));
    expect(onEditingChange).toHaveBeenLastCalledWith(false);
  });

  it("never holds today's alarms from another day's sheet", async () => {
    const { onEditingChange } = await renderCard(YESTERDAY);
    focus(field('Clock in'));
    expect(onEditingChange).not.toHaveBeenCalled();
  });

  it('undoes an Add removed before any punch changes', async () => {
    // Clocked out at 9:00, then "Add extra out / in": removing that pair gives the Clock out its 9:00 back.
    const day = emptyPunches().map((p) => ({ ...p, at: p.position === 0 ? T0 - 60 * MIN : p.position === 3 ? T0 : null }));
    const { onChange, again } = await renderCard(TODAY, day);
    fireEvent.click(screen.getByRole('button', { name: 'Add extra out / in' }));
    again(onChange.mock.lastCall![0]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Out 1 / In 1' }));
    expect(unlockAudio).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenLastCalledWith(day);
  });

  it('drops both rows of a pair punched after the Add', async () => {
    const clockedIn = emptyPunches().map((p) => ({ ...p, at: p.position === 0 ? T0 - 60 * MIN : null }));
    const { onChange, again } = await renderCard(TODAY, clockedIn);
    fireEvent.click(screen.getByRole('button', { name: 'Add extra out / in' }));
    const withPair = onChange.mock.lastCall![0];
    again(withPair);
    // Out 1 punched at 9:00, here or on another device: stepping out, which must not end the day.
    again(withPair.map((p) => (p.position === 3 ? { ...p, at: T0 } : p)));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Out 1 / In 1' }));
    expect(onChange.mock.lastCall![0].map((p) => p.at)).toEqual([T0 - 60 * MIN, null, null, null]);
  });

  it("shows the second meal on today's sheet only, not on a past day left clocked in", async () => {
    // Clocked in at midnight: 9 h worked by 9:00, past the 8 h day, so the second meal is in play.
    const longDay = emptyPunches().map((p) => ({ ...p, at: p.position === 0 ? T0 - 9 * 60 * MIN : null }));
    await renderCard(TODAY, longDay);
    expect(screen.getByText(/Second meal period/)).toBeTruthy();
    cleanup();
    // Yesterday from 8:00 and never clocked out: judged at its end, 16 h in.
    await renderCard(
      YESTERDAY,
      emptyPunches().map((p) => ({ ...p, at: p.position === 0 ? T0 - 25 * 60 * MIN : null })),
    );
    expect(screen.queryByText(/Second meal period/)).toBeNull();
  });
});
