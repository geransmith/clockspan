// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { AllProviders, makeDay, makeSession, makeSettings, MIN, settle, T0 } from '../test/hooks';
import type { Session } from '../types';
import { TimerControls } from './TimerControls';

vi.mock('../api');
vi.mock('../lib/alerts');

async function renderControls(compact: boolean, session: Session = makeSession()) {
  vi.mocked(api.getRunning).mockResolvedValue({ session });
  render(
    <AllProviders>
      <TimerControls compact={compact} />
    </AllProviders>,
  );
  await settle();
}

const button = (name: string | RegExp) => screen.getByRole('button', { name });
const names = () => screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent!.trim());

beforeEach(() => {
  vi.useFakeTimers({ now: T0 + 5 * MIN });
  vi.mocked(api.getSettings).mockResolvedValue(makeSettings({ adjustStepMinutes: 5 }));
  vi.mocked(api.getDay).mockResolvedValue(makeDay());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe('TimerControls', () => {
  it('writes each button out on the card, and names the icon buttons in the bar', async () => {
    await renderControls(false);
    expect(names()).toEqual(['5m', '5m', 'Pause', 'Finish', 'Cancel']);
    cleanup();
    await renderControls(true);
    expect(names()).toEqual(['Remove 5 minutes', 'Add 5 minutes', 'Pause timer', 'Finish', 'Cancel session']);
    expect(button('Pause timer').getAttribute('title')).toBe('Pause');
  });

  it('pauses and resumes the running session, and moves the planned end by the step', async () => {
    const running = makeSession();
    await renderControls(true, running);
    vi.mocked(api.pauseSession).mockResolvedValue({ session: { ...running, pausedAt: Date.now() } });
    fireEvent.click(button('Pause timer'));
    await settle();
    expect(api.pauseSession).toHaveBeenCalledWith(running.id);
    vi.mocked(api.resumeSession).mockResolvedValue({ session: { ...running, pausedSeconds: 0 } });
    fireEvent.click(button('Resume timer'));
    await settle();
    expect(api.resumeSession).toHaveBeenCalledWith(running.id);

    vi.mocked(api.patchSession).mockResolvedValue({ session: { ...running, plannedSeconds: running.plannedSeconds + 5 * 60 } });
    fireEvent.click(button('Add 5 minutes'));
    await settle();
    expect(api.patchSession).toHaveBeenCalledWith(running.id, { plannedSeconds: running.plannedSeconds + 5 * 60 });
  });

  it('cancels only once the confirm says yes', async () => {
    await renderControls(false);
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    fireEvent.click(button(/Cancel/));
    expect(confirm).toHaveBeenCalled();
    expect(api.cancelSession).not.toHaveBeenCalled();
    vi.mocked(api.cancelSession).mockResolvedValue({ session: { ...makeSession(), status: 'cancelled' } });
    confirm.mockReturnValue(true);
    fireEvent.click(button(/Cancel/));
    // It goes out after any write still queued, a tick later.
    await settle();
    expect(api.cancelSession).toHaveBeenCalledWith(1);
  });

  it('leaves only + and Finish once the timer has run out', async () => {
    // Two minutes past a 25-minute plan: due, and well inside the wait before it finishes itself.
    await renderControls(false, makeSession({ startedAt: T0 - 22 * MIN }));
    expect(names()).toEqual(['5m', 'Finish', 'Cancel']);
    expect((button('5m') as HTMLButtonElement).disabled).toBe(false);
  });

  it('turns + off at the longest plan the server takes, running or run out', async () => {
    await renderControls(true, makeSession({ plannedSeconds: 8 * 3600 }));
    expect((button('Add 5 minutes') as HTMLButtonElement).disabled).toBe(true);
    expect((button('Remove 5 minutes') as HTMLButtonElement).disabled).toBe(false);
    cleanup();
    await renderControls(true, makeSession({ plannedSeconds: 8 * 3600, startedAt: T0 - 8 * 60 * MIN }));
    expect(names()).toEqual(['Add 5 minutes', 'Finish', 'Cancel session']);
    fireEvent.click(button('Add 5 minutes'));
    await settle();
    expect((button('Add 5 minutes') as HTMLButtonElement).disabled).toBe(true);
    expect(api.patchSession).not.toHaveBeenCalled();
  });
});
