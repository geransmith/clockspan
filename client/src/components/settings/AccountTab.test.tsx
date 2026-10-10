// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../api';
import { ApiError } from '../../lib/apiError';
import { PASSWORD_CHANGED, PASSWORD_MISMATCH } from '../../lib/copy';
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

describe('AccountTab', () => {
  it('counts a delete answered 404 as done and reloads the list, since another device removed the user', async () => {
    vi.mocked(api.listUsers)
      .mockResolvedValueOnce({ users: [admin, sam] })
      .mockResolvedValueOnce({ users: [admin] });
    vi.mocked(api.deleteUser).mockRejectedValue(new ApiError(404, 'User not found.'));
    await renderTab();
    await deleteSam();
    expect(api.listUsers).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Delete sam' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
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

  it('deletes no user when the confirm is answered no', async () => {
    vi.mocked(api.listUsers).mockResolvedValue({ users: [admin, sam] });
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    await renderTab();
    await deleteSam();
    expect(confirm).toHaveBeenCalled();
    expect(api.deleteUser).not.toHaveBeenCalled();
  });

  it('disables every Delete and Add User while a request is out, so a confirmed press is never dropped', async () => {
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
    expect((screen.getByRole('button', { name: 'Add User' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(deleteKim);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(api.deleteUser).toHaveBeenCalledExactlyOnceWith(sam.id);
  });

  it("puts the focus in the Username box once a deleted user's Delete is disabled and gone, and leaves a focus taken elsewhere", async () => {
    const kim = makeUser({ id: 3, name: 'kim', username: 'kim' });
    vi.mocked(api.listUsers)
      .mockResolvedValueOnce({ users: [admin, sam, kim] })
      .mockResolvedValueOnce({ users: [admin, kim] })
      .mockResolvedValueOnce({ users: [admin] });
    vi.mocked(api.deleteUser).mockResolvedValue({ ok: true });
    await renderTab();
    screen.getByRole('button', { name: 'Delete sam' }).focus();
    await deleteSam();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Username' }));
    const current = screen.getByLabelText('Current password');
    current.focus();
    fireEvent.click(screen.getByRole('button', { name: 'Delete kim' }));
    await settle();
    expect(screen.queryByRole('button', { name: 'Delete kim' })).toBeNull();
    expect(document.activeElement).toBe(current);
  });

  it('says the password changed in a live region that was there before the text, and empties the boxes', async () => {
    vi.mocked(api.listUsers).mockResolvedValue({ users: [admin] });
    vi.mocked(api.changePassword).mockResolvedValue({ ok: true });
    await renderTab();
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('');
    const boxes = ['Current password', 'New password', 'Confirm new password'].map((label) => screen.getByLabelText<HTMLInputElement>(label));
    fireEvent.change(boxes[0]!, { target: { value: 'old-password' } });
    fireEvent.change(boxes[1]!, { target: { value: 'new-password' } });
    fireEvent.change(boxes[2]!, { target: { value: 'new-password' } });
    fireEvent.submit(status.closest('form')!);
    await settle();
    expect(api.changePassword).toHaveBeenCalledWith('old-password', 'new-password');
    expect(screen.getByRole('status')).toBe(status);
    expect(status.textContent).toBe(PASSWORD_CHANGED);
    expect(boxes.map((box) => box.value)).toEqual(['', '', '']);
  });

  it('sends no password change when the new password was typed differently twice', async () => {
    vi.mocked(api.listUsers).mockResolvedValue({ users: [admin] });
    await renderTab();
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'new-pass-1' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'new-pass-2' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Change Password' }).closest('form')!);
    await settle();
    expect(screen.getByRole('alert').textContent).toBe(PASSWORD_MISMATCH);
    expect(api.changePassword).not.toHaveBeenCalled();
  });

  it('names the account on the change-password form for password managers', async () => {
    vi.mocked(api.listUsers).mockResolvedValue({ users: [admin] });
    const { container } = await renderTab();
    const username = container.querySelector<HTMLInputElement>('input[autocomplete="username"]');
    expect(username?.value).toBe('admin');
    expect(username?.hidden).toBe(true);
    expect(username?.form?.textContent).toContain('Current password');
  });

  it('labels the add-user fields', async () => {
    vi.mocked(api.listUsers).mockResolvedValue({ users: [admin] });
    await renderTab();
    expect(screen.getByRole('textbox', { name: 'Username' })).toBeTruthy();
    expect(screen.getByLabelText('Temporary password')).toBeTruthy();
  });
});
