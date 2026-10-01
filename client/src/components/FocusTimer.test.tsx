// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { useDay } from '../hooks/useDay';
import { unlockAudio } from '../lib/alerts';
import { BREAK } from '../lib/copy';
import { AllProviders, deferred, makeBreak, makeDay, makeSession, makeSettings, settle, T0, TODAY } from '../test/hooks';
import type { Break, Priority, SessionResponse } from '../types';
import { MAX_PRIORITIES } from '../../../shared/settings.js';
import { FocusTimer } from './FocusTimer';

vi.mock('../api');
vi.mock('../lib/alerts');

/** The card as the sheet wires it: today's priorities from the store, and the store's addPriority. */
function Card() {
  const { day, store } = useDay(TODAY);
  if (!day) return null;
  return <FocusTimer date={TODAY} isToday priorities={day.priorities} onAddPriority={(text) => store.addPriority(TODAY, text)} />;
}

async function renderCard(priorities: Priority[] = [], breaks: Break[] = []) {
  vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { priorities, breaks }));
  render(
    <AllProviders>
      <Card />
    </AllProviders>,
  );
  await settle();
}

const start25 = () => screen.getByRole('button', { name: /^25\s*min$/ });
const typeLabel = (text: string) => fireEvent.change(screen.getByLabelText('Session label'), { target: { value: text } });
const alsoAdd = () => screen.queryByRole('checkbox', { name: "Also add to today's priorities" });
const started = (session = makeSession({ label: 'Call the vendor' })): SessionResponse => ({ session });
const disabled = (name: string | RegExp) => (screen.getByRole('button', { name }) as HTMLButtonElement).disabled;

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  vi.mocked(api.getSettings).mockResolvedValue(makeSettings());
  vi.mocked(api.getRunning).mockResolvedValue({ session: null });
  vi.mocked(api.putPriorities).mockImplementation((_date, priorities) => Promise.resolve({ priorities }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('FocusTimer', () => {
  it('sends one start for a second tap while the first is out', async () => {
    const answer = deferred<SessionResponse>();
    vi.mocked(api.startSession).mockReturnValue(answer.promise);
    await renderCard();
    typeLabel('Write the report');
    expect(disabled(/^Break · /)).toBe(false);
    fireEvent.click(start25());
    // A break tap would race the start on another queue, so the Break button waits too.
    expect(disabled(/^Break · /)).toBe(true);
    fireEvent.click(start25());
    await settle();
    expect(api.startSession).toHaveBeenCalledTimes(1);
    expect(api.startSession).toHaveBeenCalledWith(TODAY, 25 * 60, 'Write the report', null);
    answer.resolve(started(makeSession({ label: 'Write the report' })));
    await settle();
    expect(screen.getByRole('timer')).toBeTruthy();
  });

  it('holds End break while a start is out', async () => {
    const answer = deferred<SessionResponse>();
    vi.mocked(api.startSession).mockReturnValue(answer.promise);
    // A break that started half a minute ago and runs five minutes.
    await renderCard([], [makeBreak({ startedAt: T0 - 30_000, endedAt: T0 + 270_000 })]);
    expect(disabled(BREAK.end)).toBe(false);
    fireEvent.click(start25());
    expect(disabled(BREAK.end)).toBe(true);
    answer.resolve(started());
    await settle();
    // The running timer takes the card's place, break and all.
    expect(screen.queryByRole('button', { name: BREAK.end })).toBeNull();
    expect(screen.getByRole('timer')).toBeTruthy();
  });

  it('links a session to the chip that was picked', async () => {
    vi.mocked(api.startSession).mockResolvedValue(started());
    await renderCard([{ position: 1, text: 'Ship the fix', done: false, uid: 'abcdef123456', addedAt: T0 }]);
    fireEvent.click(screen.getByRole('button', { name: /Ship the fix/ }));
    // A picked row needs no "also add": it is on the plan already.
    expect(alsoAdd()).toBeNull();
    fireEvent.click(start25());
    await settle();
    expect(api.startSession).toHaveBeenCalledWith(TODAY, 25 * 60, 'Ship the fix', 'abcdef123456');
  });

  it('adds typed work to the plan and starts linked to the new row', async () => {
    vi.mocked(api.startSession).mockResolvedValue(started());
    await renderCard();
    typeLabel('Call the vendor');
    fireEvent.click(alsoAdd()!);
    fireEvent.click(start25());
    await settle();
    const rows = vi.mocked(api.putPriorities).mock.lastCall![1];
    expect(rows[0]).toMatchObject({ text: 'Call the vendor', done: false });
    expect(api.startSession).toHaveBeenCalledWith(TODAY, 25 * 60, 'Call the vendor', rows[0]!.uid);
  });

  it('does not offer to add typed work to a full list', async () => {
    const full = Array.from({ length: MAX_PRIORITIES }, (_, i) => ({ position: i + 1, text: `Row ${i + 1}`, done: true, uid: `uid${i}`, addedAt: T0 }));
    await renderCard(full);
    typeLabel('Call the vendor');
    expect(alsoAdd()).toBeNull();
  });

  it('offers it while one row is still free', async () => {
    const almost = Array.from({ length: MAX_PRIORITIES - 1 }, (_, i) => ({ position: i + 1, text: `Row ${i + 1}`, done: true, uid: `uid${i}`, addedAt: T0 }));
    await renderCard(almost);
    typeLabel('Call the vendor');
    expect(alsoAdd()).toBeTruthy();
  });

  it('unlocks audio in the tap, before the priority is saved', async () => {
    vi.mocked(api.startSession).mockResolvedValue(started());
    await renderCard();
    typeLabel('Call the vendor');
    fireEvent.click(alsoAdd()!);
    expect(unlockAudio).not.toHaveBeenCalled();
    fireEvent.click(start25());
    // Within the click itself, not after the priority's save answers.
    expect(unlockAudio).toHaveBeenCalled();
    await settle();
    expect(api.startSession).toHaveBeenCalledWith(TODAY, 25 * 60, 'Call the vendor', expect.any(String));
  });

  it('retries a failed start against the row it already added, not a second copy', async () => {
    vi.mocked(api.startSession).mockRejectedValueOnce(new Error('The server did not answer in time.')).mockResolvedValueOnce(started());
    await renderCard();
    typeLabel('Call the vendor');
    fireEvent.click(alsoAdd()!);
    fireEvent.click(start25());
    await settle();
    expect(screen.getByText('The server did not answer in time.')).toBeTruthy();
    expect(alsoAdd()).toBeNull();
    expect(screen.getByRole('button', { name: /Call the vendor/, pressed: true })).toBeTruthy();

    fireEvent.click(start25());
    await settle();
    expect(api.putPriorities).toHaveBeenCalledTimes(1);
    const uid = vi.mocked(api.putPriorities).mock.lastCall![1][0]!.uid;
    expect(vi.mocked(api.startSession).mock.calls.map((c) => c[3])).toEqual([uid, uid]);
  });
});
