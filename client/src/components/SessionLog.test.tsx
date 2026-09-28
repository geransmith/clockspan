// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { CONFIRM } from '../lib/copy';
import { makeSession, makeSettings, MIN, settle, SettingsAndDays, T0, TODAY } from '../test/hooks';
import type { Priority, Session } from '../types';
import { SessionLog } from './SessionLog';

vi.mock('../api');
vi.mock('../lib/alerts');

const PLANNED: Priority[] = [{ position: 1, text: 'Ship the fix', done: false, uid: 'abcdef123456', addedAt: T0 }];
const DONE = makeSession({ status: 'completed', endedAt: T0 + 25 * MIN, durationSeconds: 25 * 60 });

async function renderLog(sessions: Session[] = [DONE]) {
  render(
    <SettingsAndDays>
      <SessionLog date={TODAY} sessions={sessions} priorities={PLANNED} now={T0 + 30 * MIN} />
    </SettingsAndDays>,
  );
  await settle();
}

const openEdit = () => fireEvent.click(screen.getByRole('button', { name: /Write the report/ }));
const labelInput = () => screen.getByRole('textbox', { name: 'Session label' }) as HTMLInputElement;
const planSelect = () => screen.getByRole('combobox', { name: 'Priority this session was for' }) as HTMLSelectElement;

beforeEach(() => {
  vi.useFakeTimers({ now: T0 + 30 * MIN });
  vi.mocked(api.getSettings).mockResolvedValue(makeSettings());
  vi.mocked(api.patchSession).mockImplementation((id, patch) => Promise.resolve({ session: { ...DONE, id, ...patch } }));
  vi.mocked(api.deleteSession).mockResolvedValue({ ok: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe('SessionLog', () => {
  it('sends a new label and a priority link together, in one PATCH', async () => {
    await renderLog();
    openEdit();
    fireEvent.change(labelInput(), { target: { value: 'Fix the login bug' } });
    fireEvent.change(planSelect(), { target: { value: 'abcdef123456' } });
    await settle();
    expect(api.patchSession).toHaveBeenCalledTimes(1);
    expect(api.patchSession).toHaveBeenCalledWith(1, { priorityUid: 'abcdef123456', label: 'Fix the login bug' });
  });

  it('saves the label on Enter, and sends nothing for one left as it was', async () => {
    await renderLog();
    openEdit();
    fireEvent.keyDown(labelInput(), { key: 'Enter' });
    await settle();
    expect(api.patchSession).not.toHaveBeenCalled();

    openEdit();
    fireEvent.change(labelInput(), { target: { value: '  Renamed  ' } });
    fireEvent.keyDown(labelInput(), { key: 'Enter' });
    await settle();
    expect(api.patchSession).toHaveBeenCalledWith(1, { label: 'Renamed' });
  });

  it('keeps the stored label on Escape', async () => {
    await renderLog();
    openEdit();
    fireEvent.change(labelInput(), { target: { value: 'Not this' } });
    fireEvent.keyDown(labelInput(), { key: 'Escape' });
    await settle();
    expect(screen.queryByRole('textbox', { name: 'Session label' })).toBeNull();
    expect(screen.getByRole('button', { name: /Write the report/ })).toBeTruthy();
    expect(api.patchSession).not.toHaveBeenCalled();
  });

  it('stays open while focus moves from the label to the select, and saves once it leaves both', async () => {
    await renderLog();
    openEdit();
    fireEvent.change(labelInput(), { target: { value: 'Relabeled' } });
    act(() => planSelect().focus());
    await settle();
    expect(labelInput()).toBeTruthy();
    expect(api.patchSession).not.toHaveBeenCalled();

    act(() => planSelect().blur());
    await settle();
    expect(screen.queryByRole('textbox', { name: 'Session label' })).toBeNull();
    expect(api.patchSession).toHaveBeenCalledWith(1, { label: 'Relabeled' });
  });

  it('deletes a session only once the confirm says yes, and never a running one', async () => {
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal('confirm', confirm);
    await renderLog([DONE, makeSession({ id: 2, label: 'Still going', startedAt: T0 + 26 * MIN })]);
    const [done, running] = screen.getAllByRole('button', { name: 'Delete session' }) as HTMLButtonElement[];
    expect(running!.disabled).toBe(true);
    fireEvent.click(done!);
    await settle();
    expect(confirm).toHaveBeenCalledWith(CONFIRM.deleteSession);
    expect(api.deleteSession).not.toHaveBeenCalled();
    fireEvent.click(done!);
    await settle();
    expect(api.deleteSession).toHaveBeenCalledWith(1);
  });
});
