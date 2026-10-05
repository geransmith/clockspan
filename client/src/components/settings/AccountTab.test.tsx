// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../api';
import { ApiError } from '../../lib/apiError';
import { apiError, settle } from '../../test/hooks';
import type { PublicUser } from '../../types';
import { AccountTab } from './AccountTab';

vi.mock('../../api');

const admin: PublicUser = { id: 1, name: 'admin', username: 'admin', isAdmin: true, kind: 'local', mustChangePassword: false };
const sam: PublicUser = { id: 2, name: 'sam', username: 'sam', isAdmin: false, kind: 'local', mustChangePassword: false };

async function renderTab() {
  const view = render(<AccountTab user={admin} />);
  await settle();
  return view;
}

const deleteSam = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Delete sam' }));
  await settle();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('confirm', () => true);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('AccountTab', () => {
  it('reloads the list after a refused delete, so a user another device removed goes away', async () => {
    vi.mocked(api.listUsers)
      .mockResolvedValueOnce({ users: [admin, sam] })
      .mockResolvedValueOnce({ users: [admin] });
    vi.mocked(api.deleteUser).mockRejectedValue(new ApiError(404, 'User not found.'));
    await renderTab();
    await deleteSam();
    expect(api.listUsers).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Delete sam' })).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('User not found.');
  });

  it('clears the error line when a delete is tried again', async () => {
    vi.mocked(api.listUsers).mockResolvedValue({ users: [admin, sam] });
    vi.mocked(api.deleteUser).mockRejectedValueOnce(apiError(502)).mockResolvedValueOnce({ ok: true });
    await renderTab();
    await deleteSam();
    expect(screen.getByRole('alert').textContent).toBe('Request failed (502)');
    await deleteSam();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('names the account on the change-password form for password managers', async () => {
    vi.mocked(api.listUsers).mockResolvedValue({ users: [admin] });
    const { container } = await renderTab();
    const username = container.querySelector<HTMLInputElement>('input[autocomplete="username"]');
    expect(username?.value).toBe('admin');
    expect(username?.hidden).toBe(true);
    expect(username?.form?.textContent).toContain('Current password');
  });
});
