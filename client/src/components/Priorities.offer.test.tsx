// @vitest-environment happy-dom
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { LEFT_OPEN, TODAY_OFFER } from '../lib/copy';
import type { PrioritySeed } from '../lib/recurring';
import { emptyRow } from '../lib/priorities';
import { answered, deferred, FOLLOW_UPS, makePick, makePriority, makeRecurring, makeSettings, settle, STANDUP, T0 } from '../test/hooks';
import type { Priority } from '../types';
import type { MorningOffer } from './TodayOffer';
import { FILED_QUEUE, renderCard, routineRow, textbox } from './Priorities.testkit';

vi.mock('../api');
vi.mock('../lib/alerts');

/** A row left open on the last plan: its own task, named by its text, in no category unless patched. */
const seed = (text: string, patch: Partial<PrioritySeed> = {}): PrioritySeed => makePriority(1, text, { uid: `left:${text}`, listed: 0, ...patch });

describe('Priorities: the morning offer', () => {
  const offerOf = (patch: Partial<MorningOffer> = {}): MorningOffer => ({ leftovers: null, upNext: [], recurring: [], answer: vi.fn(), ...patch });
  /** The leftovers group as the sheet hands it down, from yesterday. */
  const left = (rows: PrioritySeed[]) => ({ from: 'Yesterday', rows });
  const withOffer = (rows: Priority[], offer: MorningOffer) => renderCard(rows, [], null, offer);
  const box = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement;
  const ticks = (...names: string[]) => names.map((n) => box(n).checked);
  const over = () => document.querySelector('.today-offer [role="status"]')!.textContent;
  const perDay = (n: number) => vi.mocked(api.getSettings).mockResolvedValue(answered(makeSettings({ recurringPerDay: n })));
  const shown = () => [...document.querySelectorAll('.today-offer li')].map((li) => li.textContent);

  it('shows the leftovers and the routines due in one notice, the leftovers ticked and the routines up to Recurring rows per day', async () => {
    perDay(2);
    const offer = offerOf({ leftovers: left([seed('Invoices'), seed('Email')]), recurring: [FILED_QUEUE, FOLLOW_UPS, STANDUP] });
    await withOffer([], offer);
    const notice = document.querySelector('.today-offer')!;
    expect([...notice.querySelectorAll('strong')].map((h) => h.textContent)).toEqual([LEFT_OPEN.title('Yesterday'), TODAY_OFFER.recurring]);
    expect(ticks('Invoices', 'Email', 'Monitor the queue', 'Follow-ups', 'Standup notes')).toEqual([true, true, true, true, false]);
    expect(over()).toBe('');
    expect(screen.getByRole('button', { name: TODAY_OFFER.notToday })).toBeTruthy();
    expect(screen.queryByRole('button', { name: LEFT_OPEN.dismiss })).toBeNull();
  });

  it('ticks fewer routines for those already on the list', async () => {
    perDay(2);
    const onList = routineRow(1, makeRecurring('rcur00000009', 'Weekly report'));
    await withOffer([onList], offerOf({ leftovers: left([seed('Invoices'), seed('Email')]), recurring: [FILED_QUEUE, FOLLOW_UPS] }));
    expect(ticks('Monitor the queue', 'Follow-ups')).toEqual([true, false]);
    expect(shown()).toEqual(['Invoices', 'Email', 'Monitor the queue', 'Follow-ups']);
  });

  it('says so while more routines are ticked than Recurring rows per day, and adds them all the same', async () => {
    perDay(2);
    const { saved } = await withOffer([], offerOf({ recurring: [FILED_QUEUE, FOLLOW_UPS, STANDUP] }));
    const line = document.querySelector('.today-offer [role="status"]');
    fireEvent.click(box('Standup notes'));
    expect(over()).toBe(TODAY_OFFER.over(2));
    fireEvent.click(box('Follow-ups'));
    expect(over()).toBe('');
    fireEvent.click(box('Follow-ups'));
    expect(over()).toBe(TODAY_OFFER.over(2));
    // The same live region all along, so the line is heard when it comes.
    expect(document.querySelector('.today-offer [role="status"]')).toBe(line);
    fireEvent.click(screen.getByRole('button', { name: LEFT_OPEN.add }));
    expect(saved().map((p) => p.recurring)).toEqual([false, false, false, true, true, true]);
    expect(
      saved()
        .slice(3)
        .map((p) => p.uid),
    ).toEqual([FILED_QUEUE.uid, FOLLOW_UPS.uid, STANDUP.uid]);
  });

  it('counts the routines on the list toward the line', async () => {
    perDay(1);
    await withOffer([routineRow(1, STANDUP)], offerOf({ recurring: [FILED_QUEUE] }));
    expect(ticks('Monitor the queue')).toEqual([false]);
    expect(over()).toBe('');
    fireEvent.click(box('Monitor the queue'));
    expect(over()).toBe(TODAY_OFFER.over(1));
  });

  it("counts a routine's row toward the ticks and the line while its box is blank", async () => {
    perDay(1);
    await withOffer([routineRow(1, STANDUP)], offerOf({ recurring: [FILED_QUEUE, STANDUP] }));
    fireEvent.change(textbox(1), { target: { value: '' } });
    // Still the routine's row: it isn't offered again, and it takes the day's one routine.
    expect(shown()).toEqual(['Monitor the queue']);
    expect(ticks('Monitor the queue')).toEqual([false]);
    fireEvent.click(box('Monitor the queue'));
    expect(over()).toBe(TODAY_OFFER.over(1));
  });

  it('adds what is ticked in one save, the leftovers first and the routines after the padded rows, and answers every item shown', async () => {
    perDay(2);
    const answer = vi.fn();
    const leftovers = [seed('Invoices'), seed('Email')];
    const { onChange, saved } = await withOffer([], offerOf({ leftovers: left(leftovers), recurring: [FILED_QUEUE, FOLLOW_UPS, STANDUP], answer }));
    fireEvent.click(box('Email'));
    fireEvent.click(screen.getByRole('button', { name: LEFT_OPEN.add }));
    // The notice waits for the save, and answers once it is in.
    expect(document.querySelector('.today-offer')).toBeNull();
    expect(answer).not.toHaveBeenCalled();
    await settle();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(saved().map((p) => [p.position, p.text, p.uid, p.recurring])).toEqual([
      [1, 'Invoices', 'left:Invoices', false],
      [2, '', null, false],
      [3, '', null, false],
      [4, 'Monitor the queue', FILED_QUEUE.uid, true],
      [5, 'Follow-ups', FOLLOW_UPS.uid, true],
    ]);
    expect(saved()[3]).toMatchObject({ addedAt: T0, categoryUid: FILED_QUEUE.categoryUid });
    // Standup notes was shown and left unticked: answered all the same.
    expect(answer).toHaveBeenCalledExactlyOnceWith([FILED_QUEUE.uid, FOLLOW_UPS.uid, STANDUP.uid], true);
    expect(document.activeElement).toBe(textbox(1));
    // The leftovers go with the one-off written, and the routines added with their rows; the sheet
    // then hands down no Standup notes, answered (the Sheet tests).
    expect(shown()).toEqual(['Standup notes']);
  });

  it('adds Up next after the leftovers, in the free rows before the routines, and answers it as Start fresh does', async () => {
    perDay(1);
    const answer = vi.fn();
    const upNext = [seed('Follow up'), seed('Draft the rota'), seed('Write a KB')];
    const { saved } = await withOffer([], offerOf({ leftovers: left([seed('Invoices')]), upNext, recurring: [FILED_QUEUE], answer }));
    const notice = document.querySelector('.today-offer')!;
    expect([...notice.querySelectorAll('strong')].map((h) => h.textContent)).toEqual([LEFT_OPEN.title('Yesterday'), TODAY_OFFER.upNext, TODAY_OFFER.recurring]);
    expect(ticks('Invoices', 'Follow up', 'Draft the rota', 'Write a KB', 'Monitor the queue')).toEqual([true, true, true, false, true]);
    fireEvent.click(screen.getByRole('button', { name: LEFT_OPEN.add }));
    expect(saved().map((p) => [p.position, p.uid])).toEqual([
      [1, 'left:Invoices'],
      [2, 'left:Follow up'],
      [3, 'left:Draft the rota'],
      [4, FILED_QUEUE.uid],
    ]);
    expect(document.activeElement).toBe(textbox(1));
    await settle();
    expect(answer).toHaveBeenCalledExactlyOnceWith([FILED_QUEUE.uid], true);
  });

  it('is Start fresh with only Up next shown, which holds it for the day', async () => {
    const answer = vi.fn();
    await withOffer([], offerOf({ upNext: [seed('Follow up')], answer }));
    fireEvent.click(screen.getByRole('button', { name: LEFT_OPEN.dismiss }));
    expect(answer).toHaveBeenCalledExactlyOnceWith([], true);
  });

  it("answers nothing when Add's save fails, and shows the notice again", async () => {
    const answer = vi.fn();
    const { onChange, again } = await withOffer([], offerOf({ leftovers: left([seed('Invoices')]), recurring: [FILED_QUEUE], answer }));
    const save = deferred<boolean>();
    onChange.mockReturnValueOnce(save.promise);
    fireEvent.click(screen.getByRole('button', { name: LEFT_OPEN.add }));
    expect(document.querySelector('.today-offer')).toBeNull();
    save.resolve(false);
    await settle();
    expect(answer).not.toHaveBeenCalled();
    // The store drops the change, so the stored list shows again, and the notice with it.
    again([]);
    expect(shown()).toEqual(['Invoices', 'Monitor the queue']);
  });

  it('with no routine due shows the leftovers alone, each a ticked box, and brings each over as its own task, in its category, added now', async () => {
    const answer = vi.fn();
    const seeds = [seed('Invoices', { listed: 1, logged: 600 }), seed('Call the bank', { categoryUid: 'cafe00000001' })];
    const { saved } = await withOffer([], offerOf({ leftovers: left(seeds), answer }));
    expect(screen.getByRole('group', { name: LEFT_OPEN.title('Yesterday') })).toBeTruthy();
    expect(ticks('Invoices', 'Call the bank')).toEqual([true, true]);
    fireEvent.click(screen.getByRole('button', { name: LEFT_OPEN.add }));
    expect(saved().map((p) => [p.text, p.uid, p.categoryUid])).toEqual([
      ['Invoices', 'left:Invoices', null],
      ['Call the bank', 'left:Call the bank', 'cafe00000001'],
      ['', null, null],
    ]);
    expect(saved()[0]).toMatchObject({ position: 1, done: false, addedAt: T0, listed: 1, logged: 600 });
    expect(document.activeElement).toBe(textbox(1));
    await settle();
    // Start fresh then holds, so taking a row off again offers nothing back.
    expect(answer).toHaveBeenCalledExactlyOnceWith([], true);
  });

  it('puts the focus on the leftover it filled, past a routine kept ahead of it', async () => {
    const { saved } = await withOffer([routineRow(1, FILED_QUEUE)], offerOf({ leftovers: left([seed('Invoices')]) }));
    fireEvent.click(screen.getByRole('button', { name: LEFT_OPEN.add }));
    expect(saved().map((p) => p.text)).toEqual(['Monitor the queue', 'Invoices', '']);
    expect(document.activeElement).toBe(textbox(2));
  });

  it('puts the focus on a routine Add put after the padded rows, a row the card had not drawn yet', async () => {
    await withOffer([], offerOf({ recurring: [FILED_QUEUE] }));
    fireEvent.click(screen.getByRole('button', { name: LEFT_OPEN.add }));
    expect(document.activeElement).toBe(textbox(4));
  });

  it('with nothing ticked, adds no row, answers every item shown and puts the focus where a new priority goes', async () => {
    const answer = vi.fn();
    const { saved } = await withOffer(
      [emptyRow(1), routineRow(2, makeRecurring('rcur00000009', 'Weekly report'))],
      offerOf({ recurring: [FILED_QUEUE], answer }),
    );
    fireEvent.click(box('Monitor the queue'));
    fireEvent.click(screen.getByRole('button', { name: LEFT_OPEN.add }));
    expect(saved().map((p) => p.text)).toEqual(['', 'Weekly report', '']);
    await settle();
    expect(answer).toHaveBeenCalledExactlyOnceWith([FILED_QUEUE.uid], false);
    expect(document.activeElement).toBe(textbox(1));
  });

  it('answers every item shown with Not today, saving nothing, and puts the focus where a new priority goes', async () => {
    const answer = vi.fn();
    const leftovers = [seed('Invoices')];
    const { onChange } = await withOffer([routineRow(1, STANDUP)], offerOf({ leftovers: left(leftovers), recurring: [FILED_QUEUE, FOLLOW_UPS], answer }));
    fireEvent.click(box('Follow-ups'));
    fireEvent.click(screen.getByRole('button', { name: TODAY_OFFER.notToday }));
    expect(answer).toHaveBeenCalledExactlyOnceWith([FILED_QUEUE.uid, FOLLOW_UPS.uid], true);
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(textbox(2));
  });

  it('is Start fresh with only leftovers shown, and answers no routine', async () => {
    const answer = vi.fn();
    // Every row is a routine's: no free row, so the focus goes to Add Priority.
    const routines = [FILED_QUEUE, FOLLOW_UPS, STANDUP].map((item, i) => routineRow(i + 1, item));
    await withOffer(routines, offerOf({ leftovers: left([seed('Invoices')]), answer }));
    expect(screen.queryByRole('button', { name: TODAY_OFFER.notToday })).toBeNull();
    expect(screen.queryByText(TODAY_OFFER.recurring)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: LEFT_OPEN.dismiss }));
    expect(answer).toHaveBeenCalledExactlyOnceWith([], true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add Priority' }));
  });

  it('shows the routines alone once a one-off is written, the leftovers and Up next going at the first key', async () => {
    const answer = vi.fn();
    await withOffer([], offerOf({ leftovers: left([seed('Invoices')]), upNext: [seed('Follow up')], recurring: [FILED_QUEUE], answer }));
    fireEvent.change(textbox(1), { target: { value: 'C' } });
    expect(screen.queryByText(LEFT_OPEN.title('Yesterday'))).toBeNull();
    expect(screen.queryByText(TODAY_OFFER.upNext)).toBeNull();
    expect(shown()).toEqual(['Monitor the queue']);
    fireEvent.click(screen.getByRole('button', { name: TODAY_OFFER.notToday }));
    expect(answer).toHaveBeenCalledExactlyOnceWith([FILED_QUEUE.uid], false);
  });

  it('keeps the leftovers while the list holds only routines, and drops a routine a row with text holds, answering only those shown', async () => {
    const answer = vi.fn();
    await withOffer([routineRow(1, FILED_QUEUE)], offerOf({ leftovers: left([seed('Invoices')]), recurring: [FILED_QUEUE, FOLLOW_UPS], answer }));
    expect(screen.getByText(LEFT_OPEN.title('Yesterday'))).toBeTruthy();
    expect(shown()).toEqual(['Invoices', 'Follow-ups']);
    // The queue's row could still be removed today, and the notice offer it again.
    fireEvent.click(screen.getByRole('button', { name: TODAY_OFFER.notToday }));
    expect(answer).toHaveBeenCalledExactlyOnceWith([FOLLOW_UPS.uid], true);
  });

  it('shows nothing with every routine on the list and no leftover, and comes back for an item read later', async () => {
    const { again } = await withOffer([routineRow(1, FILED_QUEUE)], offerOf({ recurring: [FILED_QUEUE] }));
    expect(document.querySelector('.today-offer')).toBeNull();
    again([routineRow(1, FILED_QUEUE)], offerOf({ recurring: [FILED_QUEUE, FOLLOW_UPS] }));
    expect(ticks('Follow-ups')).toEqual([true]);
  });
});

describe('Priorities: routines on the list', () => {
  it('leaves the routines out of the nudge: three routines and two one-offs add a row with no warning', async () => {
    const rows = [routineRow(1, FILED_QUEUE), routineRow(2, FOLLOW_UPS), routineRow(3, STANDUP), makePriority(4, 'Report'), makePriority(5, 'Email')];
    const { saved } = await renderCard(rows);
    fireEvent.click(screen.getByRole('button', { name: 'Add Priority' }));
    expect(screen.getByRole('status').textContent).toBe('');
    expect(saved()).toHaveLength(6);
    expect(document.activeElement).toBe(textbox(6));
  });

  it('marks a written routine row before its chip, ticked or not, and no other row', async () => {
    const rows = [routineRow(1, FILED_QUEUE), routineRow(2, FOLLOW_UPS, { done: true }), makePriority(3, 'Report'), emptyRow(4)];
    await renderCard(rows, [], makePick());
    const ends = [...document.querySelectorAll('.priority-row')].map((r) =>
      [...(r.querySelector('.priority-end')?.children ?? [])].map((el) => (el.classList.contains('note-toggle') ? 'note-toggle' : el.className)),
    );
    expect(ends).toEqual([
      ['repeat-mark', 'note-toggle', 'category-wrap'],
      ['repeat-mark', 'note-toggle', 'category-wrap'],
      ['note-toggle', 'category-wrap'],
      [],
    ]);
    expect(screen.getAllByRole('img', { name: 'Repeats' })).toHaveLength(2);
  });

  it("shows no mark before the board's first read", async () => {
    await renderCard([routineRow(1, FILED_QUEUE)]);
    expect(screen.queryByRole('img', { name: 'Repeats' })).toBeNull();
  });
});
