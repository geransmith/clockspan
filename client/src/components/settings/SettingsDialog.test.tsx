// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MINUTE_MS } from '../../../../shared/dates.js';
import * as api from '../../api';
import { AuthGate } from '../../auth/AuthGate';
import { SAVE_STATUS } from '../../lib/copy';
import { applySettingsPatch } from '../../lib/settings';
import { SOUND_EVENT_LABELS } from '../../lib/sounds';
import { DEFAULT_USER, deferred, makeAuth, makeBoard, makeCategory, makeSettings, makeUser, settle, SettingsAndDays } from '../../test/hooks';
import type { AuthInfo, Settings } from '../../types';
import { SettingsDialog } from './SettingsDialog';

vi.mock('../../api');
vi.mock('../../lib/alerts');

const ADMIN = makeUser({ id: 1, name: 'admin', username: 'admin', isAdmin: true });

async function renderDialog(auth: AuthInfo = makeAuth({ user: ADMIN })) {
  vi.mocked(api.getAuth).mockResolvedValue(auth);
  const onClose = vi.fn();
  render(
    <AuthGate>
      <SettingsAndDays>
        <SettingsDialog onClose={onClose} />
      </SettingsAndDays>
    </AuthGate>,
  );
  await settle();
  return { onClose };
}

const tabNames = () => screen.getAllByRole('tab', { hidden: true }).map((t) => t.textContent);
const toggle = (name: string) => screen.getByRole('switch', { name, hidden: true });
const hint = (name: string) => document.getElementById(toggle(name).getAttribute('aria-describedby')!)!.textContent;
const openTab = async (name: string) => {
  fireEvent.click(screen.getByRole('tab', { name, hidden: true }));
  await settle();
};

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  vi.mocked(api.getSettings).mockResolvedValue(makeSettings());
  vi.mocked(api.putSettings).mockImplementation((patch) => Promise.resolve(applySettingsPatch(makeSettings(), patch)));
  vi.mocked(api.getPruneInfo).mockImplementation((before) => Promise.resolve({ before, matching: 0, total: 4, oldest: '2026-09-01', serverMaxDays: null }));
  vi.mocked(api.listUsers).mockResolvedValue({ users: [ADMIN] });
});

describe('SettingsDialog', () => {
  it('shows the Account tab only with local accounts', async () => {
    await renderDialog();
    expect(tabNames()).toEqual(['Timeclock', 'Alarms', 'Sheet', 'Data', 'Account']);
    cleanup();
    // Account was used last, but isn't offered now: Timeclock opens, and Account stays stored.
    localStorage.setItem('focus:settingsTab', 'account');
    await renderDialog(makeAuth({ mode: 'none', user: DEFAULT_USER }));
    expect(tabNames()).toEqual(['Timeclock', 'Alarms', 'Sheet', 'Data']);
    expect(screen.getByRole('tab', { name: 'Timeclock', hidden: true }).getAttribute('aria-selected')).toBe('true');
    expect(localStorage.getItem('focus:settingsTab')).toBe('account');
  });

  it('shows each tab its own panel, and opens on the tab used last', async () => {
    await renderDialog();
    expect(screen.getByLabelText('Work day hours')).toBeTruthy();
    await openTab('Alarms');
    expect(screen.getByText("How you're alerted")).toBeTruthy();
    await openTab('Sheet');
    expect(screen.getByLabelText('Rows per day')).toBeTruthy();
    await openTab('Data');
    expect(screen.getByText(/4 days stored/)).toBeTruthy();
    await openTab('Account');
    expect(screen.getByText('Change password')).toBeTruthy();
    expect(screen.getByText('(you)', { exact: false })).toBeTruthy();

    cleanup();
    await renderDialog();
    expect(screen.getByRole('tab', { name: 'Account', hidden: true }).getAttribute('aria-selected')).toBe('true');
  });

  it('moves between tabs with the arrow keys, wrapping at the ends', async () => {
    await renderDialog();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Timeclock', hidden: true }), { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'Account', hidden: true }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Account', hidden: true }), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Timeclock', hidden: true }).getAttribute('aria-selected')).toBe('true');
  });

  it('names a switch by its label and describes it with the hint', async () => {
    await renderDialog();
    expect(hint('Meal periods')).toMatch(/^The lunch deadline and the second meal period/);
  });

  it('saves a switch through the settings provider and says so in the header', async () => {
    await renderDialog();
    fireEvent.click(toggle('Show hours'));
    await settle();
    expect(api.putSettings).toHaveBeenCalledWith({ trackHours: false });
    expect(screen.getByRole('status', { hidden: true }).textContent).toContain(SAVE_STATUS.saved);
  });

  it('says in the header and the panel when a change was put back', async () => {
    await renderDialog();
    vi.mocked(api.putSettings).mockRejectedValueOnce(new Error('Request failed (500)'));
    fireEvent.click(toggle('Show hours'));
    await settle();
    expect(screen.getByRole('status', { hidden: true }).textContent).toBe(SAVE_STATUS.failed);
    expect(screen.getByText(SAVE_STATUS.failedDetail)).toBeTruthy();
    expect((toggle('Show hours') as HTMLInputElement).checked).toBe(true);
    // The next save that goes through clears both.
    fireEvent.click(toggle('Show hours'));
    await settle();
    expect(screen.getByRole('status', { hidden: true }).textContent).toContain(SAVE_STATUS.saved);
    expect(screen.queryByText(SAVE_STATUS.failedDetail)).toBeNull();
  });

  it('offers to hide the lunch punches only with the meal periods off', async () => {
    await renderDialog();
    expect(screen.queryByRole('switch', { name: 'Lunch punches', hidden: true })).toBeNull();
    expect(screen.getByText(/clock-out alarm only; meal alarms stay on\./)).toBeTruthy();
    fireEvent.click(toggle('Meal periods'));
    await settle();
    expect(api.putSettings).toHaveBeenCalledWith({ mealRules: false });
    expect(screen.queryByLabelText('Lunch must start within hours')).toBeNull();
    // No meal alarms to keep on, so the Overtime hint stops promising them.
    expect(screen.getByText(/clock-out alarm only\. Off where/)).toBeTruthy();
    fireEvent.click(toggle('Lunch punches'));
    await settle();
    expect(api.putSettings).toHaveBeenLastCalledWith({ lunchPunches: false });
  });

  it('lists the stickers the calendar gives, without clocked out when hours are hidden', async () => {
    await renderDialog();
    await openTab('Sheet');
    expect(hint('Sticker chart')).toContain('clocked out');
    await openTab('Timeclock');
    fireEvent.click(toggle('Show hours'));
    await settle();
    await openTab('Sheet');
    expect(hint('Sticker chart')).toMatch(/: lunch taken, all priorities done, focus session logged, retrospective reviewed\.$/);
    expect(hint('Sticker chart')).not.toContain('clocked out');
  });

  it('switches the board on from the Sheet tab, and says what it adds', async () => {
    vi.mocked(api.getBoard).mockResolvedValue(makeBoard());
    await renderDialog();
    await openTab('Sheet');
    expect(hint('Board page')).toBe(
      "Adds a Board button (a page for tasks that aren't for today), categories and recurring priorities, set up in the Board tab.",
    );
    expect(tabNames()).toEqual(['Timeclock', 'Alarms', 'Sheet', 'Data', 'Account']);
    fireEvent.click(toggle('Board page'));
    await settle();
    expect(api.putSettings).toHaveBeenCalledWith({ board: true });
    expect((toggle('Board page') as HTMLInputElement).checked).toBe(true);
    expect(tabNames()).toEqual(['Timeclock', 'Alarms', 'Sheet', 'Board', 'Data', 'Account']);
  });

  it('saves a category change on the Board tab through the header, and shows Timeclock once the board is switched off', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(makeSettings({ board: true }));
    vi.mocked(api.getBoard).mockResolvedValue({ ...makeBoard(), categories: [makeCategory('cat000000001', 'Tickets')] });
    vi.mocked(api.patchCategory).mockResolvedValue({ ...makeBoard(), categories: [makeCategory('cat000000001', 'Tickets', { color: 'pink' })] });
    await renderDialog();
    await openTab('Board');
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Colour of Tickets', hidden: true })).getByRole('radio', { name: 'Pink', hidden: true }));
    await settle();
    expect(api.patchCategory).toHaveBeenCalledWith('cat000000001', { color: 'pink' });
    expect(screen.getByRole('status', { hidden: true }).textContent).toContain(SAVE_STATUS.saved);

    vi.mocked(api.patchCategory).mockRejectedValueOnce(new Error('Request failed (500)'));
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Colour of Tickets', hidden: true })).getByRole('radio', { name: 'Teal', hidden: true }));
    await settle();
    expect(screen.getByRole('status', { hidden: true }).textContent).toBe(SAVE_STATUS.failed);

    // Another device switches the board off: the settings' next read takes the tab away.
    vi.mocked(api.getSettings).mockResolvedValue(makeSettings());
    await settle(MINUTE_MS);
    expect(tabNames()).toEqual(['Timeclock', 'Alarms', 'Sheet', 'Data', 'Account']);
    expect(screen.getByRole('tab', { name: 'Timeclock', hidden: true }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByLabelText('Work day hours')).toBeTruthy();
    // Board stays the tab picked last, for when the board is back.
    expect(localStorage.getItem('focus:settingsTab')).toBe('board');
  });

  it('hands the Board tab the settings, and saves its number through the header', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(makeSettings({ board: true, recurringPerDay: 4 }));
    vi.mocked(api.getBoard).mockResolvedValue(makeBoard());
    vi.mocked(api.putSettings).mockImplementation((patch) => Promise.resolve(applySettingsPatch(makeSettings({ board: true, recurringPerDay: 4 }), patch)));
    await renderDialog();
    await openTab('Board');
    const perDay = screen.getByRole('textbox', { name: 'Recurring rows per day', hidden: true }) as HTMLInputElement;
    expect(perDay.value).toBe('4');
    fireEvent.change(perDay, { target: { value: '6' } });
    fireEvent.blur(perDay);
    await settle();
    expect(api.putSettings).toHaveBeenCalledWith({ recurringPerDay: 6 });
    expect(perDay.value).toBe('6');
    expect(screen.getByRole('status', { hidden: true }).textContent).toContain(SAVE_STATUS.saved);
  });

  it('drops the overtime clause from the retrospective hint when Overtime is off', async () => {
    await renderDialog();
    await openTab('Alarms');
    expect(hint('Retrospective')).toMatch(/Overtime approval doesn't silence it\.$/);
    await openTab('Timeclock');
    fireEvent.click(toggle('Overtime'));
    await settle();
    await openTab('Alarms');
    expect(hint('Retrospective')).not.toContain('Overtime approval');
  });

  it('saves one alarm field or one sound without touching the others', async () => {
    await renderDialog();
    await openTab('Alarms');
    const clockOut = screen.getByRole('group', { name: 'Clock-out', hidden: true });
    expect(within(clockOut).getByRole('switch', { name: 'Clock-out', hidden: true })).toBeTruthy();
    fireEvent.click(within(clockOut).getByRole('button', { name: '30m', hidden: true }));
    await settle();
    expect(api.putSettings).toHaveBeenCalledWith({ alarms: { clockOut: { leadMinutes: [30, 15, 5, 1] } } });
    fireEvent.change(screen.getByRole('combobox', { name: `${SOUND_EVENT_LABELS.timer} sound`, hidden: true }), { target: { value: 'bell' } });
    await settle();
    expect(api.putSettings).toHaveBeenLastCalledWith({ sounds: { timer: 'bell' } });
  });

  it('holds the panel until the settings have loaded, then opens on the stored tab the settings offer', async () => {
    const answer = deferred<Settings>();
    vi.mocked(api.getSettings).mockReturnValue(answer.promise);
    vi.mocked(api.getBoard).mockResolvedValue(makeBoard());
    localStorage.setItem('focus:settingsTab', 'board');
    await renderDialog();
    // The defaults stand in: their start buttons are not the user's, so no box shows them.
    expect(screen.queryByLabelText('Work day hours')).toBeNull();
    expect(document.querySelector('[role="tabpanel"] .sheet-loading')).toBeTruthy();
    answer.resolve(makeSettings({ board: true }));
    await settle();
    expect(screen.getByRole('tab', { name: 'Board', hidden: true }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('textbox', { name: 'Recurring rows per day', hidden: true })).toBeTruthy();
  });

  it('points only the shown tab at its panel', async () => {
    await renderDialog();
    const controls = screen.getAllByRole('tab', { hidden: true }).map((t) => t.getAttribute('aria-controls'));
    expect(controls).toEqual(['panel-timeclock', null, null, null, null]);
    expect(document.getElementById('panel-timeclock')).toBeTruthy();
  });

  it('saves a typed number when Escape closes the dialog with the focus still in its box', async () => {
    const { onClose } = await renderDialog();
    await openTab('Sheet');
    const rows = screen.getByRole('textbox', { name: 'Rows per day', hidden: true }) as HTMLInputElement;
    rows.focus();
    fireEvent.change(rows, { target: { value: '6' } });
    fireEvent.keyDown(rows, { key: 'Escape' });
    await settle();
    expect(api.putSettings).toHaveBeenCalledWith({ priorityCount: 6 });
    expect(onClose).toHaveBeenCalled();
  });

  it('saves a typed number when Close is pressed with the focus still in its box', async () => {
    const { onClose } = await renderDialog();
    await openTab('Sheet');
    const rows = screen.getByRole('textbox', { name: 'Rows per day', hidden: true }) as HTMLInputElement;
    rows.focus();
    fireEvent.change(rows, { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close settings', hidden: true }));
    await settle();
    expect(api.putSettings).toHaveBeenCalledWith({ priorityCount: 6 });
    expect(onClose).toHaveBeenCalled();
  });
});
