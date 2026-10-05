// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../api';
import { ApiError } from '../../lib/apiError';
import { PASSWORD_CHANGED } from '../../lib/copy';
import { apiError, makeUser, settle } from '../../test/hooks';
import { AccountTab } from './AccountTab';

vi.mock('../../api');

const admin = makeUser({ id: 1, name: 'admin', username: 'admin', isAdmin: true });
const sam = makeUser();

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

  it('disables every Delete and Add user while a request is out, so a confirmed press is never dropped', async () => {
    const kim = makeUser({ id: 3, name: 'kim', username: 'kim' });
    vi.mocked(api.listUsers).mockResolvedValue({ users: [admin, sam, kim] });
    vi.mocked(api.deleteUser).mockReturnValue(new Promise(() => {}));
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    await renderTab();
    await deleteSam();
    const deleteKim = screen.getByRole('button', { name: 'Delete kim' }) as HTMLButtonElement;
    expect(deleteKim.disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Delete sam' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Add user' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(deleteKim);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(api.deleteUser).toHaveBeenCalledExactlyOnceWith(sam.id);
  });

  it('says the password changed in a live region that was there before the text', async () => {
    vi.mocked(api.listUsers).mockResolvedValue({ users: [admin] });
    vi.mocked(api.changePassword).mockResolvedValue({ ok: true });
    await renderTab();
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('');
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'old-password' } });
    fireEvent.submit(status.closest('form')!);
    await settle();
    expect(api.changePassword).toHaveBeenCalledWith('old-password', '');
    expect(screen.getByRole('status')).toBe(status);
    expect(status.textContent).toBe(PASSWORD_CHANGED);
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
