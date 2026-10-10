// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { useDay } from '../hooks/useDay';
import { unlockAudio } from '../lib/alerts';
import { HOUR_MS, MINUTE_MS } from '../../../shared/dates.js';
import { answered, AppProviders, endSession, makeDay, makePriority, makeSession, makeSettings, pressKey, settle, ShortcutKeys, T0, TODAY } from '../test/hooks';
import type { Session } from '../types';
import { TimerControls } from './TimerControls';

vi.mock('../api');
vi.mock('../lib/alerts');

/** Today's day held in the store, as the app always holds it: Done looks for the task's row there. */
function HoldToday() {
  useDay(TODAY);
  return null;
}

async function renderControls(compact: boolean, session: Session = makeSession()) {
  vi.mocked(api.getRunning).mockResolvedValue(answered({ session }));
  render(
    <AppProviders>
      <ShortcutKeys />
      <HoldToday />
      <TimerControls compact={compact} />
    </AppProviders>,
  );
  await settle();
}

const row = makePriority(1, 'Ship the fix', { uid: 'u1' });
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const keys = (name: string | RegExp) => button(name).getAttribute('aria-keyshortcuts');
const names = () => screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent!.trim());

beforeEach(() => {
  vi.useFakeTimers({ now: T0 + 5 * MINUTE_MS });
  vi.mocked(api.getSettings).mockResolvedValue(answered(makeSettings({ adjustStepMinutes: 5 })));
  vi.mocked(api.getDay).mockResolvedValue(answered(makeDay()));
});

describe('TimerControls', () => {
  it('writes each button out on the card, and names the icon buttons in the bar', async () => {
    await renderControls(false);
    // − and + both read "5m", so each carries a name that says which way.
    expect(names()).toEqual(['Remove 5 minutes', 'Add 5 minutes', 'Pause', 'Finish', 'Cancel']);
    cleanup();
    await renderControls(true);
    expect(names()).toEqual(['Remove 5 minutes', 'Add 5 minutes', 'Pause timer', 'Finish timer', 'Cancel session']);
  });

  it('pauses and resumes the running session, and moves the planned end by the step', async () => {
    const running = makeSession();
    await renderControls(true, running);
    vi.mocked(api.pauseSession).mockResolvedValue(answered({ session: { ...running, pausedAt: Date.now() } }));
    fireEvent.click(button('Pause timer'));
    await settle();
    expect(api.pauseSession).toHaveBeenCalledWith(running.id);
    vi.mocked(api.resumeSession).mockResolvedValue(answered({ session: { ...running, pausedSeconds: 0 } }));
    fireEvent.click(button('Resume timer'));
    await settle();
    expect(api.resumeSession).toHaveBeenCalledWith(running.id);

    vi.mocked(api.patchSession).mockResolvedValue(answered({ session: { ...running, plannedSeconds: running.plannedSeconds + 5 * 60 } }));
    fireEvent.click(button('Add 5 minutes'));
    await settle();
    expect(api.patchSession).toHaveBeenCalledWith(running.id, { plannedSeconds: running.plannedSeconds + 5 * 60 });
  });

  it("offers Done after Finish only while the session's task is open on its day", async () => {
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { priorities: [row] })));
    await renderControls(false, makeSession({ priorityUid: 'u1' }));
    expect(names()).toEqual(['Remove 5 minutes', 'Add 5 minutes', 'Pause', 'Finish', 'Done', 'Cancel']);
    cleanup();
    await renderControls(true, makeSession({ priorityUid: 'u1' }));
    expect(names()).toEqual(['Remove 5 minutes', 'Add 5 minutes', 'Pause timer', 'Finish timer', 'Done with this task', 'Cancel session']);
    cleanup();
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { priorities: [{ ...row, done: true }] })));
    await renderControls(true, makeSession({ priorityUid: 'u1' }));
    expect(names()).toEqual(['Remove 5 minutes', 'Add 5 minutes', 'Pause timer', 'Finish timer', 'Cancel session']);
  });

  it('unlocks the sound in the Done tap, finishes, then ticks the task', async () => {
    const running = makeSession({ priorityUid: 'u1' });
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { priorities: [row] })));
    vi.mocked(api.finishSession).mockResolvedValue(answered({ session: endSession(running) }));
    vi.mocked(api.putPriorities).mockImplementation((_date, priorities) => Promise.resolve(answered({ priorities })));
    await renderControls(false, running);
    fireEvent.click(button('Done'));
    expect(unlockAudio).toHaveBeenCalled();
    await settle();
    expect(api.finishSession).toHaveBeenCalledWith(running.id, false);
    expect(vi.mocked(api.putPriorities).mock.lastCall?.[1][0]).toEqual({ ...row, done: true });
  });

  it('cancels only once the confirm says yes', async () => {
    await renderControls(false);
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    fireEvent.click(button(/Cancel/));
    expect(confirm).toHaveBeenCalled();
    expect(api.cancelSession).not.toHaveBeenCalled();
    vi.mocked(api.cancelSession).mockResolvedValue(answered({ session: endSession(makeSession(), { status: 'cancelled' }) }));
    confirm.mockReturnValue(true);
    fireEvent.click(button(/Cancel/));
    // It goes out after any write still queued, a tick later.
    await settle();
    expect(api.cancelSession).toHaveBeenCalledWith(1);
  });

  it('leaves +, Finish and Cancel once the timer has run out', async () => {
    // Two minutes past a 25-minute plan: due, and well inside the wait before it finishes itself.
    await renderControls(false, makeSession({ startedAt: T0 - 22 * MINUTE_MS }));
    expect(names()).toEqual(['Add 5 minutes', 'Finish', 'Cancel']);
    expect((button('Add 5 minutes') as HTMLButtonElement).disabled).toBe(false);
  });

  it('turns + off at the longest plan the server takes, running or run out', async () => {
    await renderControls(true, makeSession({ plannedSeconds: 8 * 3600 }));
    expect((button('Add 5 minutes') as HTMLButtonElement).disabled).toBe(true);
    expect((button('Remove 5 minutes') as HTMLButtonElement).disabled).toBe(false);
    cleanup();
    await renderControls(true, makeSession({ plannedSeconds: 8 * 3600, startedAt: T0 - 8 * HOUR_MS }));
    expect(names()).toEqual(['Add 5 minutes', 'Finish timer', 'Cancel session']);
    expect((button('Add 5 minutes') as HTMLButtonElement).disabled).toBe(true);
  });

  it("pauses and resumes on P and adds the step on +, each button naming its key, while F waits for time's up", async () => {
    const running = makeSession();
    await renderControls(false, running);
    expect([keys('Remove 5 minutes'), keys('Add 5 minutes'), keys('Pause'), keys('Finish')]).toEqual([null, 'Plus', 'P', null]);
    expect(pressKey('f')).toBe(true);
    expect(pressKey('-')).toBe(true);
    vi.mocked(api.pauseSession).mockResolvedValue(answered({ session: { ...running, pausedAt: Date.now() } }));
    pressKey('p');
    await settle();
    expect(api.pauseSession).toHaveBeenCalledWith(running.id);
    expect(keys('Resume')).toBe('P');
    vi.mocked(api.resumeSession).mockResolvedValue(answered({ session: { ...running, pausedSeconds: 0 } }));
    pressKey('P');
    await settle();
    expect(api.resumeSession).toHaveBeenCalledWith(running.id);
    vi.mocked(api.patchSession).mockResolvedValue(answered({ session: { ...running, plannedSeconds: running.plannedSeconds + 5 * 60 } }));
    pressKey('+');
    await settle();
    expect(api.patchSession).toHaveBeenCalledWith(running.id, { plannedSeconds: running.plannedSeconds + 5 * 60 });
    expect(api.finishSession).not.toHaveBeenCalled();
  });

  it("finishes on F once time's up, where P does nothing, and leaves + alone at the longest plan", async () => {
    // Half a minute past a 25-minute plan: due, with no length to ask about.
    const due = makeSession({ startedAt: T0 - 20.5 * MINUTE_MS });
    await renderControls(true, due);
    expect(keys('Finish timer')).toBe('F');
    expect(pressKey('p')).toBe(true);
    vi.mocked(api.finishSession).mockResolvedValue(answered({ session: endSession(due, { durationSeconds: 25 * 60 }) }));
    pressKey('f');
    await settle();
    expect(api.finishSession).toHaveBeenCalledOnce();
    expect(api.pauseSession).not.toHaveBeenCalled();
    cleanup();
    await renderControls(true, makeSession({ plannedSeconds: 8 * 3600 }));
    expect(keys('Add 5 minutes')).toBeNull();
    expect(pressKey('+')).toBe(true);
  });
});
