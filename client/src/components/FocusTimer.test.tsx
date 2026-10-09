// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { useDay } from '../hooks/useDay';
import { dismissByTag, unlockAudio } from '../lib/alerts';
import { BREAK } from '../lib/copy';
import type { CategoryPick } from '../lib/board';
import {
  AppProviders,
  deferred,
  endSession,
  makeBreak,
  makeCategory,
  makeDay,
  makePick,
  makePriority,
  makeSession,
  makeSettings,
  settle,
  T0,
  TODAY,
} from '../test/hooks';
import type { Break, Priority, SessionResponse } from '../types';
import { MAX_PRIORITIES } from '../../../shared/settings.js';
import { FocusTimer } from './FocusTimer';

vi.mock('../api');
vi.mock('../lib/alerts');

/** The card as the sheet wires it: today's priorities from the store. */
function Card({ pick }: { pick: CategoryPick | null }) {
  const { day } = useDay(TODAY);
  if (!day) return null;
  return <FocusTimer date={TODAY} isToday priorities={day.priorities} pick={pick} />;
}

/** `n` priority rows, all ticked. */
const ticked = (n: number) => Array.from({ length: n }, (_, i) => makePriority(i + 1, `Row ${i + 1}`, { done: true }));

async function renderCard(priorities: Priority[] = [], breaks: Break[] = [], pick: CategoryPick | null = null) {
  vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { priorities, breaks }));
  const view = render(
    <AppProviders>
      <Card pick={pick} />
    </AppProviders>,
  );
  await settle();
  return {
    /** The board goes off (on another device): the sheet passes no chip data. */
    boardOff: () =>
      view.rerender(
        <AppProviders>
          <Card pick={null} />
        </AppProviders>,
      ),
  };
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
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toBeTruthy();
  });

  it('holds the start buttons while a break start is out', async () => {
    const answer = deferred<{ break: Break }>();
    vi.mocked(api.startBreak).mockReturnValue(answer.promise);
    await renderCard();
    fireEvent.click(screen.getByRole('button', { name: /^Break · / }));
    // A start would race the break on another queue, so it waits for the break's answer.
    expect(disabled(/^25\s*min$/)).toBe(true);
    answer.resolve({ break: makeBreak({ startedAt: T0, endedAt: T0 + 5 * 60_000 }) });
    await settle();
    expect(disabled(/^25\s*min$/)).toBe(false);
    expect(screen.getByRole('button', { name: BREAK.end })).toBeTruthy();
  });

  it("takes the break banners down in the start's tap, so their Start break can't race it", async () => {
    vi.mocked(api.startSession).mockReturnValue(deferred<SessionResponse>().promise);
    await renderCard();
    vi.mocked(dismissByTag).mockClear();
    fireEvent.click(start25());
    // In the click, before the start has answered and the running timer takes them down.
    expect(dismissByTag).toHaveBeenCalledWith('break');
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
    await renderCard([makePriority(1, 'Ship the fix', { uid: 'abcdef123456' })]);
    fireEvent.click(screen.getByRole('button', { name: /Ship the fix/ }));
    // A picked row needs no "also add": it is on the plan already.
    expect(alsoAdd()).toBeNull();
    fireEvent.click(start25());
    await settle();
    expect(api.startSession).toHaveBeenCalledWith(TODAY, 25 * 60, 'Ship the fix', 'abcdef123456');
  });

  it("names the running session by its row's current text, not the label it started with", async () => {
    vi.mocked(api.getRunning).mockResolvedValue({ session: makeSession({ label: 'Started as this', priorityUid: 'abcdef123456' }) });
    await renderCard([makePriority(1, 'Ship the fix', { uid: 'abcdef123456' })]);
    expect(screen.getByText('Ship the fix').className).toBe('timer-running-label');
    expect(screen.queryByText('Started as this')).toBeNull();
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

  it('does not offer to add text an open row already has, as when a chip is unlinked', async () => {
    await renderCard([makePriority(1, 'Ship the fix'), makePriority(2, 'Email', { done: true })]);
    const chip = screen.getByRole('button', { name: /Ship the fix/ });
    fireEvent.click(chip);
    fireEvent.click(chip);
    expect(screen.getByLabelText<HTMLInputElement>('Session label').value).toBe('Ship the fix');
    expect(alsoAdd()).toBeNull();
    typeLabel('  ship THE fix ');
    expect(alsoAdd()).toBeNull();
    // A ticked row's text is new work again.
    typeLabel('Email');
    expect(alsoAdd()).not.toBeNull();
  });

  it('starts linked to the open row whose name was typed, as its chip would', async () => {
    vi.mocked(api.startSession).mockResolvedValue(started());
    await renderCard([makePriority(1, 'Ship the fix', { uid: 'abcdef123456' })]);
    typeLabel('  ship THE fix ');
    fireEvent.click(start25());
    await settle();
    expect(api.startSession).toHaveBeenCalledWith(TODAY, 25 * 60, 'ship THE fix', 'abcdef123456');
  });

  it("starts unplanned under a ticked row's name", async () => {
    vi.mocked(api.startSession).mockResolvedValue(started());
    await renderCard([makePriority(1, 'Email', { uid: 'abcdef123456', done: true })]);
    typeLabel('Email');
    fireEvent.click(start25());
    await settle();
    expect(api.startSession).toHaveBeenCalledWith(TODAY, 25 * 60, 'Email', null);
  });

  it('does not offer to add typed work to a full list', async () => {
    await renderCard(ticked(MAX_PRIORITIES));
    typeLabel('Call the vendor');
    expect(alsoAdd()).toBeNull();
  });

  it('adds typed work in the first free row, between written ones', async () => {
    vi.mocked(api.startSession).mockResolvedValue(started());
    await renderCard([makePriority(1, 'Report'), makePriority(3, 'Email')]);
    typeLabel('Call the vendor');
    fireEvent.click(alsoAdd()!);
    fireEvent.click(start25());
    await settle();
    const rows = vi.mocked(api.putPriorities).mock.lastCall![1];
    expect(rows.map((p) => p.text)).toEqual(['Report', 'Call the vendor', 'Email']);
    expect(api.startSession).toHaveBeenCalledWith(TODAY, 25 * 60, 'Call the vendor', rows[1]!.uid);
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

  describe("the new row's category", () => {
    const TICKETS = makeCategory('cat000000001', 'Tickets');
    const ADMIN = makeCategory('cat000000002', 'Admin', { color: 'teal' });
    const chip = () => screen.queryByRole('button', { name: /^Category for the new priority:/ });

    it('offers a chip only while Also add is ticked, and adds the row in the category picked', async () => {
      vi.mocked(api.startSession).mockResolvedValue(started());
      await renderCard([], [], makePick([TICKETS, ADMIN]));
      typeLabel('Call the vendor');
      expect(chip()).toBeNull();
      fireEvent.click(alsoAdd()!);
      expect(chip()!.getAttribute('aria-label')).toBe('Category for the new priority: none');
      fireEvent.click(chip()!);
      fireEvent.click(screen.getByRole('option', { name: 'Admin' }));
      expect(chip()!.getAttribute('aria-label')).toBe('Category for the new priority: Admin');
      // Unticked, the chip goes and nothing is sent; ticked again, the pick is still there.
      fireEvent.click(alsoAdd()!);
      expect(chip()).toBeNull();
      fireEvent.click(alsoAdd()!);
      expect(chip()!.getAttribute('aria-label')).toBe('Category for the new priority: Admin');
      expect(api.putPriorities).not.toHaveBeenCalled();

      fireEvent.click(start25());
      await settle();
      const row = vi.mocked(api.putPriorities).mock.lastCall![1][0]!;
      expect(row).toMatchObject({ text: 'Call the vendor', categoryUid: ADMIN.uid });
      expect(api.startSession).toHaveBeenCalledWith(TODAY, 25 * 60, 'Call the vendor', row.uid);
    });

    it('starts the next session with no category, as the label starts empty', async () => {
      vi.mocked(api.startSession).mockResolvedValue(started());
      vi.mocked(api.finishSession).mockResolvedValue({ session: endSession(makeSession({ label: 'Call the vendor' })) });
      await renderCard([], [], makePick([TICKETS]));
      typeLabel('Call the vendor');
      fireEvent.click(alsoAdd()!);
      fireEvent.click(chip()!);
      fireEvent.click(screen.getByRole('option', { name: 'Tickets' }));
      fireEvent.click(start25());
      await settle();
      fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
      await settle();
      expect(screen.getByLabelText<HTMLInputElement>('Session label').value).toBe('');
      typeLabel('Email the vendor');
      fireEvent.click(alsoAdd()!);
      expect(chip()!.getAttribute('aria-label')).toBe('Category for the new priority: none');
    });

    it('starts the next session with no category after a start linked to an open row, which adds none', async () => {
      const row = makePriority(1, 'Ship the fix');
      vi.mocked(api.startSession).mockResolvedValue(started(makeSession({ label: 'Ship the fix', priorityUid: row.uid })));
      vi.mocked(api.finishSession).mockResolvedValue({ session: endSession(makeSession({ label: 'Ship the fix', priorityUid: row.uid })) });
      await renderCard([row], [], makePick([TICKETS]));
      typeLabel('Call the vendor');
      fireEvent.click(alsoAdd()!);
      fireEvent.click(chip()!);
      fireEvent.click(screen.getByRole('option', { name: 'Tickets' }));
      // The row's link chip takes the label and the Also add offer with it.
      fireEvent.click(screen.getByRole('button', { name: /Ship the fix/ }));
      expect(alsoAdd()).toBeNull();
      fireEvent.click(start25());
      await settle();
      expect(api.putPriorities).not.toHaveBeenCalled();
      expect(api.startSession).toHaveBeenCalledWith(TODAY, 25 * 60, 'Ship the fix', row.uid);
      fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
      await settle();
      typeLabel('Email the vendor');
      fireEvent.click(alsoAdd()!);
      expect(chip()!.getAttribute('aria-label')).toBe('Category for the new priority: none');
    });

    it('starts the next session with no category after a start with Also add unticked', async () => {
      vi.mocked(api.startSession).mockResolvedValue(started());
      vi.mocked(api.finishSession).mockResolvedValue({ session: endSession(makeSession({ label: 'Call the vendor' })) });
      await renderCard([], [], makePick([TICKETS]));
      typeLabel('Call the vendor');
      fireEvent.click(alsoAdd()!);
      fireEvent.click(chip()!);
      fireEvent.click(screen.getByRole('option', { name: 'Tickets' }));
      fireEvent.click(alsoAdd()!);
      fireEvent.click(start25());
      await settle();
      expect(api.putPriorities).not.toHaveBeenCalled();
      expect(api.startSession).toHaveBeenCalledWith(TODAY, 25 * 60, 'Call the vendor', null);
      fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
      await settle();
      typeLabel('Email the vendor');
      fireEvent.click(alsoAdd()!);
      expect(chip()!.getAttribute('aria-label')).toBe('Category for the new priority: none');
    });

    it('offers no category again once the row is added, a failed start included', async () => {
      vi.mocked(api.startSession).mockRejectedValueOnce(new Error('The server did not answer in time.'));
      await renderCard([], [], makePick([TICKETS]));
      typeLabel('Call the vendor');
      fireEvent.click(alsoAdd()!);
      fireEvent.click(chip()!);
      fireEvent.click(screen.getByRole('option', { name: 'Tickets' }));
      fireEvent.click(start25());
      await settle();
      expect(vi.mocked(api.putPriorities).mock.lastCall![1][0]).toMatchObject({ text: 'Call the vendor', categoryUid: TICKETS.uid });
      // The start failed after the row went on the list, linked: unlinked, new text offers Also add again.
      fireEvent.click(screen.getByRole('button', { name: /Call the vendor/, pressed: true }));
      typeLabel('Email the vendor');
      fireEvent.click(alsoAdd()!);
      expect(chip()!.getAttribute('aria-label')).toBe('Category for the new priority: none');
    });

    it('adds the row with no category with the board off, a pick made before it went off included', async () => {
      vi.mocked(api.startSession).mockResolvedValue(started());
      const { boardOff } = await renderCard([], [], makePick([TICKETS]));
      typeLabel('Call the vendor');
      fireEvent.click(alsoAdd()!);
      fireEvent.click(chip()!);
      fireEvent.click(screen.getByRole('option', { name: 'Tickets' }));
      boardOff();
      expect(chip()).toBeNull();
      fireEvent.click(start25());
      await settle();
      expect(vi.mocked(api.putPriorities).mock.lastCall![1][0]).toMatchObject({ text: 'Call the vendor', categoryUid: null });
    });
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
