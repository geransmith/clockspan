// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { SettingsProvider } from '../hooks/useSettings';
import { unlockAudio } from '../lib/alerts';
import { addPunchPair, emptyPunches, timeclockForDate } from '../lib/timeclock';
import { makeSettings, MIN, settle, T0, TODAY } from '../test/hooks';
import type { Punch } from '../types';
import { Timeclock } from './Timeclock';

vi.mock('../api');
vi.mock('../lib/alerts');

const YESTERDAY = '2026-09-27';

async function renderCard(date = TODAY, punches: Punch[] = emptyPunches()) {
  const onEditingChange = vi.fn<(editing: boolean) => void>();
  const onChange = vi.fn<(punches: Punch[]) => void>();
  const view = render(
    <SettingsProvider>
      <Timeclock
        date={date}
        isToday={date === TODAY}
        now={T0}
        punches={punches}
        tc={timeclockForDate(punches, makeSettings(), date, TODAY, T0)}
        overtimeApproved={false}
        workMinutes={null}
        week={null}
        focus={{ seconds: 0, count: 0 }}
        onChange={onChange}
        onOvertimeChange={vi.fn()}
        onWorkMinutesChange={vi.fn()}
        onEditingChange={onEditingChange}
      />
    </SettingsProvider>,
  );
  await settle();
  return { ...view, onEditingChange, onChange };
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

  it("never holds today's alarms from another day's sheet", async () => {
    const { onEditingChange } = await renderCard(YESTERDAY);
    focus(field('Clock in'));
    expect(onEditingChange).not.toHaveBeenCalled();
  });

  it('unlocks audio before a removed pair is saved', async () => {
    // Clocked out at 9:00, then an extra pair added: removing it hands 9:00 back to the Clock out.
    const punches = addPunchPair(emptyPunches().map((p) => ({ ...p, at: p.position === 0 ? T0 - 60 * MIN : p.position === 3 ? T0 : null })));
    const { onChange } = await renderCard(TODAY, punches);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Out 1 / In 1' }));
    expect(unlockAudio).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledOnce();
  });
});
