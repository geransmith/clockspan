// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { playSound, unlockAudio } from '../lib/alerts';
import { PLAN_NEXT } from '../lib/copy';
import { deferred, makeDay, makeSettings, SettingsAndDays, settle, T0, TODAY } from '../test/hooks';
import type { Day, Priority } from '../types';
import { PlanNext } from './PlanNext';

vi.mock('../api');
vi.mock('../lib/alerts');

// TODAY is a Monday, so the plan is for the Tuesday.
const NEXT = '2026-09-29';
const row = (position: number, text: string, extra: Partial<Priority> = {}): Priority => ({
  position,
  text,
  done: false,
  uid: `uid${position}`.padEnd(12, '0'),
  addedAt: T0 - 60 * 60_000,
  ...extra,
});
// The day's rows as stored, which can include an empty one.
const TODAYS: Priority[] = [row(1, 'Ship it', { done: true }), row(2, 'Review the PR'), row(3, 'Call the bank'), { ...row(4, ''), uid: null, addedAt: null }];

async function renderPlan({ date = TODAY, next = makeDay(NEXT) as Day | Promise<Day> } = {}) {
  vi.mocked(api.getDay).mockImplementation((d) => (d === NEXT ? Promise.resolve(next) : Promise.resolve(makeDay(d))));
  const card = (rows: Priority[]) => (
    <SettingsAndDays>
      <PlanNext date={date} today={TODAY} priorities={rows} />
    </SettingsAndDays>
  );
  const view = render(card(TODAYS));
  await settle();
  return { ...view, again: (rows: Priority[]) => view.rerender(card(rows)) };
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
  vi.useFakeTimers({ now: T0 + 8 * 60 * 60_000 });
  vi.mocked(api.getSettings).mockResolvedValue(makeSettings({ sounds: { ...makeSettings().sounds, planDone: 'triad' } }));
  vi.mocked(api.putPriorities).mockImplementation((_date, priorities) => Promise.resolve({ priorities }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('PlanNext', () => {
  it("offers a plan on today's retrospective only, and loads the next day once it opens", async () => {
    const { container } = await renderPlan({ date: '2026-09-25' });
    expect(container.textContent).toBe('');
    cleanup();
    await renderPlan();
    expect(api.getDay).not.toHaveBeenCalled();
    await open();
    expect(api.getDay).toHaveBeenCalledExactlyOnceWith(NEXT);
  });

  it("can't save until the next day is in, and Cancel closes without saving", async () => {
    const next = deferred<Day>();
    await renderPlan({ next: next.promise });
    await open();
    expect(saveButton().disabled).toBe(true);
    next.resolve(makeDay(NEXT));
    await settle();
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: PLAN_NEXT.save('tomorrow') })).toBeNull();
    expect(api.putPriorities).not.toHaveBeenCalled();
    expect(status()).toBe('');
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
    expect(screen.getByRole('button', { name: PLAN_NEXT.open('tomorrow') })).toBeTruthy();
    expect(playSound).toHaveBeenCalledExactlyOnceWith('triad');
    expect(document.querySelector('.burst')).not.toBeNull();
  });

  it("keeps each tick on its row when today's list is renumbered while open", async () => {
    const { again } = await renderPlan();
    await open();
    fireEvent.click(box('Review the PR'));
    // 'Ship it' removed on the Priorities card: the rows below it move up, with their uids.
    again([
      { ...TODAYS[1]!, position: 1 },
      { ...TODAYS[2]!, position: 2 },
    ]);
    expect(box('Review the PR').checked).toBe(false);
    expect(box('Call the bank').checked).toBe(true);
    await save();
    expect(sent().map((p) => p.text)).toEqual(['Call the bank']);
  });

  it("doesn't offer a row already on the next day's list, whatever the case and spacing", async () => {
    const kept = row(1, 'review the  pr', { addedAt: T0 });
    await renderPlan({ next: makeDay(NEXT, { priorities: [kept] }) });
    await open();
    expect(screen.getByRole('heading').textContent).toBe(`${PLAN_NEXT.title('tomorrow')} ${PLAN_NEXT.already(1)}`);
    expect(screen.queryByRole('checkbox', { name: 'Review the PR' })).toBeNull();
    await save();
    expect(sent()).toEqual([kept, expect.objectContaining({ position: 2, text: 'Call the bank' })]);
    expect(status()).toBe(PLAN_NEXT.done(1, 'tomorrow'));
  });

  it('saves nothing when nothing is new, and says so without a celebration', async () => {
    await renderPlan({ next: makeDay(NEXT, { priorities: [row(1, 'Review the PR'), row(2, 'Call the bank')] }) });
    await open();
    expect(screen.queryByRole('list')).toBeNull();
    // A blank line isn't added.
    type('   ');
    expect(screen.queryByRole('list')).toBeNull();
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
