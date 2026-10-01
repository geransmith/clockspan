// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { CONFIRM } from '../lib/copy';
import { useTimer } from '../hooks/useTimer';
import { AllProviders, deferred, makeDay, makeSession, makeSettings, MIN, settle, T0, TODAY } from '../test/hooks';
import type { Break, Priority, Session, SessionResponse } from '../types';
import { SessionLog } from './SessionLog';

vi.mock('../api');
vi.mock('../lib/alerts');

const PLANNED: Priority[] = [{ position: 1, text: 'Ship the fix', done: false, uid: 'abcdef123456', addedAt: T0 }];
const DONE = makeSession({ status: 'completed', endedAt: T0 + 25 * MIN, durationSeconds: 25 * 60 });
const RUNNING = makeSession({ id: 2, label: 'Still going', startedAt: T0 + 26 * MIN });

/** A break of `minutes` that started `at` minutes after T0 and ran its length. */
const rest = (id: number, at: number, minutes: number): Break => ({
  id,
  date: TODAY,
  plannedSeconds: minutes * 60,
  startedAt: T0 + at * MIN,
  endedAt: T0 + (at + minutes) * MIN,
});

/** The running timer's label, as the bar at the top shows it. */
function BarLabel() {
  return <output aria-label="Running bar">{useTimer().running?.label}</output>;
}

async function renderLog(sessions: Session[] = [DONE], breaks: Break[] = [], date = TODAY) {
  render(
    <AllProviders>
      <BarLabel />
      <SessionLog date={date} isToday={date === TODAY} sessions={sessions} breaks={breaks} priorities={PLANNED} now={T0 + 30 * MIN} />
    </AllProviders>,
  );
  await settle();
}

const openEdit = () => fireEvent.click(screen.getByRole('button', { name: /Write the report/ }));
const labelInput = () => screen.getByRole('textbox', { name: 'Session label' }) as HTMLInputElement;
const planSelect = () => screen.getByRole('combobox', { name: 'Priority this session was for' }) as HTMLSelectElement;
const bar = () => screen.getByRole('status', { name: 'Running bar' }).textContent;

beforeEach(() => {
  vi.useFakeTimers({ now: T0 + 30 * MIN });
  vi.mocked(api.getSettings).mockResolvedValue(makeSettings());
  vi.mocked(api.getRunning).mockResolvedValue({ session: null });
  vi.mocked(api.getDay).mockResolvedValue(makeDay());
  vi.mocked(api.patchSession).mockImplementation((id, patch) => Promise.resolve({ session: { ...DONE, id, ...patch } }));
  vi.mocked(api.deleteSession).mockResolvedValue({ ok: true });
  vi.mocked(api.deleteBreak).mockResolvedValue({ ok: true });
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

  it('stays in the edit while an input method is composing, and saves on the Enter after it', async () => {
    await renderLog();
    openEdit();
    fireEvent.change(labelInput(), { target: { value: '会議' } });
    // The input method's own keys: Enter picks a candidate, Escape drops one.
    fireEvent.keyDown(labelInput(), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(labelInput(), { key: 'Escape', isComposing: true });
    await settle();
    expect(labelInput().value).toBe('会議');
    expect(api.patchSession).not.toHaveBeenCalled();
    fireEvent.keyDown(labelInput(), { key: 'Enter' });
    await settle();
    expect(screen.queryByRole('textbox', { name: 'Session label' })).toBeNull();
    expect(api.patchSession).toHaveBeenCalledExactlyOnceWith(1, { label: '会議' });
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

  it('edits the running row through the timer, so the bar shows the edit too', async () => {
    vi.mocked(api.getRunning).mockResolvedValue({ session: RUNNING });
    const answer = deferred<SessionResponse>();
    vi.mocked(api.patchSession).mockReturnValue(answer.promise);
    await renderLog([DONE, RUNNING]);
    expect(bar()).toBe('Still going');
    fireEvent.click(screen.getByRole('button', { name: /Still going/ }));
    fireEvent.change(labelInput(), { target: { value: 'Renamed' } });
    fireEvent.change(planSelect(), { target: { value: 'abcdef123456' } });
    await settle();
    expect(api.patchSession).toHaveBeenCalledTimes(1);
    expect(api.patchSession).toHaveBeenCalledWith(2, { priorityUid: 'abcdef123456', label: 'Renamed' });
    // Both at once, before the server answers.
    expect(bar()).toBe('Renamed');
    expect(screen.getByRole('button', { name: /Renamed/ }).textContent).toBe('1Renamed');
    expect(screen.getByRole('img', { name: 'Priority 1' }).textContent).toBe('1');
    answer.resolve({ session: { ...RUNNING, label: 'Renamed', priorityUid: 'abcdef123456' } });
    await settle();
    expect(bar()).toBe('Renamed');
  });

  it('shows the running row as the timer has it', async () => {
    // Renamed in the bar: the day's copy hasn't heard yet.
    vi.mocked(api.getRunning).mockResolvedValue({ session: { ...RUNNING, label: 'Renamed in the bar', pausedAt: T0 + 29 * MIN } });
    await renderLog([DONE, RUNNING]);
    const row = screen.getAllByRole('listitem')[1]!.textContent;
    expect(row).toMatch(/Renamed in the bar/);
    expect(row).toMatch(/paused/);
  });

  it('deletes a session only once the confirm says yes, and never a running one', async () => {
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal('confirm', confirm);
    await renderLog([DONE, RUNNING]);
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

  it('lists breaks between the sessions they followed, with their own total', async () => {
    const later = makeSession({ id: 2, label: 'Second one', startedAt: T0 + 40 * MIN, status: 'completed', endedAt: T0 + 50 * MIN, durationSeconds: 600 });
    // A break still running at `now` counts what it has so far.
    await renderLog([later, DONE], [rest(1, 25, 5), rest(2, 28, 5)]);
    const rows = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatch(/Write the report/);
    expect(rows[1]).toMatch(/Break.*5m/);
    expect(rows[2]).toMatch(/Break.*on break.*2m/);
    expect(rows[3]).toMatch(/Second one/);
    expect(screen.getByText('On breaks').parentElement!.textContent).toBe('On breaks7m· 2 breaks');
  });

  it('shows breaks alone, and no break total without any', async () => {
    await renderLog([], [rest(1, 0, 5)]);
    expect(screen.getByText('On breaks').parentElement!.textContent).toBe('On breaks5m· 1 break');
    cleanup();
    await renderLog();
    expect(screen.queryByText('On breaks')).toBeNull();
  });

  it('says why the log is empty, today and on a past day', async () => {
    await renderLog([]);
    expect(screen.getByText(/No focus sessions yet/)).toBeTruthy();
    cleanup();
    // A past day with nothing logged isn't waiting for anything.
    await renderLog([], [], '2026-09-25');
    expect(screen.getByText('No focus sessions or breaks on this day.')).toBeTruthy();
  });

  it('deletes a break once the confirm says yes, and never one still running', async () => {
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal('confirm', confirm);
    await renderLog([DONE], [rest(7, 25, 3), rest(8, 29, 5)]);
    const [over, running] = screen.getAllByRole('button', { name: 'Delete break' }) as HTMLButtonElement[];
    expect(running!.disabled).toBe(true);
    fireEvent.click(over!);
    await settle();
    expect(confirm).toHaveBeenCalledWith(CONFIRM.deleteBreak);
    expect(api.deleteBreak).not.toHaveBeenCalled();
    fireEvent.click(over!);
    await settle();
    expect(api.deleteBreak).toHaveBeenCalledWith(7);
  });
});
