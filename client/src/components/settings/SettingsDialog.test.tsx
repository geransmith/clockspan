// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../api';
import { AuthGate } from '../../auth/AuthGate';
import { SettingsProvider } from '../../hooks/useSettings';
import { SAVE_STATUS } from '../../lib/copy';
import { makeSettings, settle } from '../../test/hooks';
import type { AuthInfo } from '../../types';
import { SettingsDialog } from './SettingsDialog';

vi.mock('../../api', async (importOriginal) => {
  const { UNAUTHENTICATED_EVENT } = await importOriginal<typeof import('../../api')>();
  return {
    UNAUTHENTICATED_EVENT,
    getAuth: vi.fn(),
    getSettings: vi.fn(),
    putSettings: vi.fn(),
    getPruneInfo: vi.fn(),
    listUsers: vi.fn(),
  };
});
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
      <SettingsProvider>
        <SettingsDialog onClose={onClose} />
      </SettingsProvider>
    </AuthGate>,
  );
  await settle();
  return { onClose };
}

const tabNames = () => screen.getAllByRole('tab', { hidden: true }).map((t) => t.textContent);
const openTab = async (name: string) => {
  fireEvent.click(screen.getByRole('tab', { name, hidden: true }));
  await settle();
};

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  vi.mocked(api.getSettings).mockResolvedValue(makeSettings());
  vi.mocked(api.putSettings).mockImplementation((patch) => Promise.resolve(makeSettings(patch)));
  vi.mocked(api.getPruneInfo).mockResolvedValue({ before: '2025-09-28', matching: 0, total: 4, oldest: '2026-09-01', serverMaxDays: null });
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

  it('saves a switch through the settings provider and says so in the header', async () => {
    await renderDialog();
    fireEvent.click(screen.getByRole('switch', { name: /Show hours/, hidden: true }));
    expect(api.putSettings).toHaveBeenCalledWith({ trackHours: false });
    await settle();
    expect(screen.getByRole('status', { hidden: true }).textContent).toContain(SAVE_STATUS.saved);
  });

  it('saves one alarm field without touching the others', async () => {
    await renderDialog();
    await openTab('Alarms');
    const defaults = makeSettings().alarms;
    fireEvent.click(screen.getAllByRole('button', { name: '30m', hidden: true })[1]!);
    expect(api.putSettings).toHaveBeenCalledWith({ alarms: { ...defaults, clockOut: { ...defaults.clockOut, leadMinutes: [30, 15, 5, 1] } } });
  });
});
