// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HOUR_MS } from '../../../shared/dates.js';
import * as api from '../api';
import { playSound, unlockAudio } from '../lib/alerts';
import { LOAD_FAILED, PLAN_NEXT } from '../lib/copy';
import type { CategoryPick } from '../lib/board';
import { deferred, makeCategory, makeDay, makePick, makePriority, makeSettings, rowUid, SettingsAndDays, settle, T0, TODAY } from '../test/hooks';
import type { Day, Priority } from '../types';
import { PlanNext } from './PlanNext';

vi.mock('../api');
vi.mock('../lib/alerts');

// TODAY is a Monday, so the plan is for the Tuesday.
const NEXT = '2026-09-29';
// The day's rows as stored, which can include an empty one.
const TODAYS: Priority[] = [
  makePriority(1, 'Ship it', { done: true }),
  makePriority(2, 'Review the PR'),
  makePriority(3, 'Call the bank'),
  makePriority(4, '', { uid: null, addedAt: null }),
];

async function renderPlan({ next = makeDay(NEXT) as Day | Promise<Day>, todays = TODAYS, pick = null as CategoryPick | null } = {}) {
  vi.mocked(api.getDay).mockImplementation((d) => (d === NEXT ? Promise.resolve(next) : Promise.resolve(makeDay(d))));
  const card = (rows: Priority[]) => (
    <SettingsAndDays>
      <PlanNext today={TODAY} priorities={rows} pick={pick} />
    </SettingsAndDays>
  );
  const view = render(card(todays));
  await settle();
  return {
    ...view,
    again: (rows: Priority[]) => view.rerender(card(rows)),
    /** The board goes off (on another device) while the planner is open: the sheet passes no chip data. */
    boardOff: () =>
      view.rerender(
        <SettingsAndDays>
          <PlanNext today={TODAY} priorities={todays} pick={null} />
        </SettingsAndDays>,
      ),
  };
}

const open = async () => {
  fireEvent.click(screen.getByRole('button', { name: PLAN_NEXT.open('tomorrow') }));
  await settle();
};
const saveButton = () => screen.getByRole('button', { name: PLAN_NEXT.save('tomorrow') }) as HTMLButtonElement;
const save = async () => {
  fireEvent.click(saveButton());
  await settle();
};
const draft = () => screen.getByRole('textbox', { name: PLAN_NEXT.placeholder }) as HTMLInputElement;
const type = (text: string, enter = true) => {
  fireEvent.change(draft(), { target: { value: text } });
  if (enter) fireEvent.keyDown(draft(), { key: 'Enter' });
};
const box = (text: string) => screen.getByRole('checkbox', { name: text }) as HTMLInputElement;
const status = () => screen.getByRole('status').textContent;
const sent = () => vi.mocked(api.putPriorities).mock.calls[0]![1];

beforeEach(() => {
  vi.useFakeTimers({ now: T0 + 8 * HOUR_MS });
  vi.mocked(api.getSettings).mockResolvedValue(makeSettings({ sounds: { ...makeSettings().sounds, planDone: 'triad' } }));
  vi.mocked(api.putPriorities).mockImplementation((_date, priorities) => Promise.resolve({ priorities }));
});

describe('PlanNext', () => {
  it('loads the next day once the planner opens', async () => {
    await renderPlan();
    expect(api.getDay).not.toHaveBeenCalled();
    await open();
    expect(api.getDay).toHaveBeenCalledExactlyOnceWith(NEXT);
  });

  it("can't save until the next day is in, and Cancel closes without saving", async () => {
    const next = deferred<Day>();
    await renderPlan({ next: next.promise });
    await open();
    expect(document.activeElement).toBe(draft());
    expect(saveButton().disabled).toBe(true);
    next.resolve(makeDay(NEXT));
    await settle();
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: PLAN_NEXT.save('tomorrow') })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: PLAN_NEXT.open('tomorrow') }));
    expect(api.putPriorities).not.toHaveBeenCalled();
    expect(status()).toBe('');
  });

  it('shows a failed load of the next day with Try again, and can add once it loads', async () => {
    await renderPlan();
    vi.mocked(api.getDay).mockRejectedValueOnce(new Error('Request failed (502)'));
    await open();
    expect(screen.getByRole('alert').textContent).toContain(LOAD_FAILED.title);
    expect(saveButton().disabled).toBe(true);
    expect(box('Review the PR').checked).toBe(true);
    fireEvent.click(box('Call the bank'));
    fireEvent.click(screen.getByRole('button', { name: LOAD_FAILED.retry }));
    await settle();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(saveButton().disabled).toBe(false);
    // The ticks made before the retry are still there.
    expect(box('Review the PR').checked).toBe(true);
    expect(box('Call the bank').checked).toBe(false);
    expect(vi.mocked(api.getDay).mock.calls).toEqual([[NEXT], [NEXT]]);
  });

  it("carries today's open rows over ticked, with what was typed after them", async () => {
    await renderPlan();
    await open();
    // Ticked rows and empty ones aren't offered.
    expect(screen.getAllByRole('checkbox').map((c) => c.closest('label')!.textContent)).toEqual(['Review the PR', 'Call the bank']);
    expect(box('Review the PR').checked).toBe(true);
    fireEvent.click(box('Call the bank'));
    type('Book flights');
    expect(draft().value).toBe('');
    expect(screen.getAllByRole('listitem').map((li) => li.textContent?.trim())).toEqual(['Review the PR', 'Call the bank', 'Book flights']);
    // Typed and not yet added with Enter still counts.
    type('  Pay rent  ', false);
    await save();

    expect(unlockAudio).toHaveBeenCalled();
    expect(api.putPriorities).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.putPriorities).mock.calls[0]![0]).toBe(NEXT);
    expect(sent().map((p) => [p.position, p.text, p.done, p.addedAt])).toEqual([
      [1, 'Review the PR', false, Date.now()],
      [2, 'Book flights', false, Date.now()],
      [3, 'Pay rent', false, Date.now()],
    ]);
    expect(new Set(sent().map((p) => p.uid)).size).toBe(3);
    expect(status()).toBe(PLAN_NEXT.done(3, 'tomorrow'));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: PLAN_NEXT.open('tomorrow') }));
    expect(playSound).toHaveBeenCalledExactlyOnceWith('triad');
    expect(document.querySelector('.burst')).not.toBeNull();
  });

  it("doesn't carry an open routine: it comes back on its own weekdays", async () => {
    await renderPlan({ todays: [...TODAYS, makePriority(5, 'Monitor the queue', { uid: 'rcur00000001', recurring: true })] });
    await open();
    expect(screen.getAllByRole('checkbox').map((c) => c.closest('label')!.textContent)).toEqual(['Review the PR', 'Call the bank']);
    await save();
    expect(sent().map((p) => p.text)).toEqual(['Review the PR', 'Call the bank']);
  });

  it("keeps each tick on its row when today's list is renumbered while open", async () => {
    const { again } = await renderPlan();
    await open();
    fireEvent.click(box('Review the PR'));
    // Today's list renumbered (a row above them gone): the rows below move up, with their uids.
    again([
      { ...TODAYS[1]!, position: 1 },
      { ...TODAYS[2]!, position: 2 },
    ]);
    expect(box('Review the PR').checked).toBe(false);
    expect(box('Call the bank').checked).toBe(true);
    await save();
    expect(sent().map((p) => p.text)).toEqual(['Call the bank']);
  });

  it("doesn't offer a task already on the next day's list, under any name, and offers another task of the same text", async () => {
    const kept = { ...TODAYS[1]!, position: 1, text: 'Review the pull request' };
    const twin = makePriority(2, 'call the  bank', { uid: 'twin00000001' });
    await renderPlan({ next: makeDay(NEXT, { priorities: [kept, twin] }) });
    await open();
    expect(screen.getByRole('heading').textContent).toBe(`${PLAN_NEXT.title('tomorrow')} ${PLAN_NEXT.already(2)}`);
    expect(screen.getAllByRole('checkbox').map((c) => c.closest('label')!.textContent)).toEqual(['Call the bank']);
    await save();
    expect(sent()).toEqual([kept, twin, expect.objectContaining({ position: 3, text: 'Call the bank', uid: TODAYS[2]!.uid })]);
    // With the list it was built on, so a row another device put there meanwhile stays.
    expect(vi.mocked(api.putPriorities).mock.calls[0]![2]).toEqual([kept, twin]);
    expect(status()).toBe(PLAN_NEXT.done(1, 'tomorrow'));
  });

  it('carries each row it brings over as the same task, with its category and counts, and a typed row as a new task', async () => {
    const carried = makePriority(1, 'Review the PR', { categoryUid: 'cafe00000001', listed: 2, earlier: 1, logged: 600 });
    await renderPlan({ todays: [carried, makePriority(2, 'Call the bank')] });
    await open();
    type('Book flights');
    await save();
    expect(sent().map((p) => [p.text, p.uid, p.categoryUid, p.listed, p.earlier, p.logged])).toEqual([
      ['Review the PR', carried.uid, 'cafe00000001', 2, 1, 600],
      ['Call the bank', rowUid(2), null, 1, 0, 0],
      ['Book flights', sent()[2]!.uid, null, 0, 0, 0],
    ]);
    expect([carried.uid, rowUid(2)]).not.toContain(sent()[2]!.uid);
  });

  it('offers a category for each row typed in while the board is on, and sends each row in its own', async () => {
    const tickets = makeCategory('cat000000001', 'Tickets');
    const admin = makeCategory('cat000000002', 'Admin', { color: 'teal' });
    const chip = (text: string) => screen.queryByRole('button', { name: new RegExp(`^Category for ${text}:`) });
    await renderPlan({ todays: [makePriority(1, 'Review the PR', { categoryUid: tickets.uid })], pick: makePick([tickets, admin]) });
    await open();
    type('Book flights');
    type('Pay rent');
    // A row carried over keeps its own category, and has no chip.
    expect(chip('Review the PR')).toBeNull();
    expect(chip('Book flights')!.getAttribute('aria-label')).toBe('Category for Book flights: none');
    expect(chip('Book flights')!.closest('li')!.className).toBe('plan-next-extra');
    fireEvent.click(chip('Book flights')!);
    fireEvent.click(screen.getByRole('option', { name: 'Admin' }));
    expect(chip('Book flights')!.getAttribute('aria-label')).toBe('Category for Book flights: Admin');
    expect(chip('Pay rent')!.getAttribute('aria-label')).toBe('Category for Pay rent: none');
    fireEvent.click(chip('Pay rent')!);
    fireEvent.click(screen.getByRole('option', { name: 'Tickets' }));
    // Typed and not entered: it has had no chip, so it goes with no category, whatever the row before it has.
    type('Call the bank', false);
    await save();
    expect(sent().map((p) => [p.text, p.categoryUid])).toEqual([
      ['Review the PR', tickets.uid],
      ['Book flights', admin.uid],
      ['Pay rent', tickets.uid],
      ['Call the bank', null],
    ]);
  });

  it('offers no category for a row typed in with the board off', async () => {
    await renderPlan();
    await open();
    type('Book flights');
    expect(screen.queryByRole('button', { name: /^Category for/ })).toBeNull();
  });

  it('sends no category for a row whose chip went with the board, a pick made before included', async () => {
    const admin = makeCategory('cat000000002', 'Admin', { color: 'teal' });
    const { boardOff } = await renderPlan({ pick: makePick([admin]) });
    await open();
    type('Book flights');
    fireEvent.click(screen.getByRole('button', { name: /^Category for Book flights:/ }));
    fireEvent.click(screen.getByRole('option', { name: 'Admin' }));
    boardOff();
    expect(screen.queryByRole('button', { name: /^Category for/ })).toBeNull();
    await save();
    expect(sent().find((p) => p.text === 'Book flights')).toMatchObject({ categoryUid: null });
  });

  it('saves nothing when nothing is new, and says so without a celebration', async () => {
    await renderPlan({
      next: makeDay(NEXT, {
        priorities: [
          { ...TODAYS[1]!, position: 1 },
          { ...TODAYS[2]!, position: 2 },
        ],
      }),
    });
    await open();
    expect(screen.queryByRole('list')).toBeNull();
    // A blank line isn't added.
    type('   ');
    expect(screen.queryByRole('list')).toBeNull();
    // Nor is one left in the box at Save.
    type('  ', false);
    await save();
    expect(api.putPriorities).not.toHaveBeenCalled();
    expect(status()).toBe(PLAN_NEXT.nothing);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(playSound).not.toHaveBeenCalled();
    expect(document.querySelector('.burst')).toBeNull();
  });

  it('stays open with the rows still offered when the save fails', async () => {
    const answer = deferred<{ priorities: Priority[] }>();
    vi.mocked(api.putPriorities).mockReturnValue(answer.promise);
    await renderPlan();
    await open();
    fireEvent.click(saveButton());
    await settle();
    expect(saveButton().disabled).toBe(true);
    answer.reject(new Error('Request failed (500)'));
    await settle();
    expect(saveButton().disabled).toBe(false);
    expect(box('Review the PR').checked).toBe(true);
    expect(status()).toBe('');
    expect(playSound).not.toHaveBeenCalled();
    expect(document.querySelector('.burst')).toBeNull();
  });
});
