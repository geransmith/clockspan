// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../api';
import { AuthGate } from '../../auth/AuthGate';
import { PASSWORD_CHANGED, SAVE_STATUS } from '../../lib/copy';
import { applySettingsPatch } from '../../lib/settings';
import { SOUND_EVENT_LABELS } from '../../lib/sounds';
import { makeSettings, settle, SettingsAndDays } from '../../test/hooks';
import type { AuthInfo } from '../../types';
import { SettingsDialog } from './SettingsDialog';

vi.mock('../../api');
vi.mock('../../lib/alerts');

const LOCAL_ADMIN: AuthInfo = {
  mode: 'local',
  setupRequired: false,
  cookieSecure: false,
  user: { id: 1, name: 'admin', username: 'admin', isAdmin: true, kind: 'local', mustChangePassword: false },
};

async function renderDialog(auth: AuthInfo = LOCAL_ADMIN) {
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
  vi.mocked(api.listUsers).mockResolvedValue({ users: [LOCAL_ADMIN.user!] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('SettingsDialog', () => {
  it('shows the Account tab only with local accounts', async () => {
    await renderDialog();
    expect(tabNames()).toEqual(['Timeclock', 'Alarms', 'Sheet', 'Data', 'Account']);
    cleanup();
    await renderDialog({ ...LOCAL_ADMIN, mode: 'none', user: { ...LOCAL_ADMIN.user!, kind: 'default', username: null } });
    expect(tabNames()).toEqual(['Timeclock', 'Alarms', 'Sheet', 'Data']);
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
    expect(toggle('Show hours').getAttribute('aria-checked')).toBe('true');
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

  it('labels the add-user fields and announces a changed password', async () => {
    await renderDialog();
    await openTab('Account');
    expect(screen.getByRole('textbox', { name: 'Username', hidden: true })).toBeTruthy();
    expect(screen.getByLabelText('Temporary password')).toBeTruthy();

    vi.mocked(api.changePassword).mockResolvedValue({ ok: true });
    const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
    type('Current password', 'old-pass-123');
    type('New password', 'new-pass-123');
    type('Confirm new password', 'new-pass-123');
    fireEvent.submit(screen.getByRole('button', { name: 'Change password', hidden: true }).closest('form')!);
    await settle();
    expect(api.changePassword).toHaveBeenCalledWith('old-pass-123', 'new-pass-123');
    expect(screen.getByText(PASSWORD_CHANGED).getAttribute('role')).toBe('status');
  });
});
