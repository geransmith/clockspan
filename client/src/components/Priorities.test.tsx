// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAY_MS } from '../../../shared/dates.js';
import { mergePriorities } from '../../../shared/priorities.js';
import * as api from '../api';
import { useDay } from '../hooks/useDay';
import { SettingsProvider } from '../hooks/useSettings';
import { playSound, unlockAudio } from '../lib/alerts';
import { EMPTIED_RECURRING, EMPTIED_ROW, LEFT_OPEN, PRIORITY_WARNINGS, TODAY_OFFER, WARNING_ACTIONS } from '../lib/copy';
import type { PrioritySeed } from '../lib/plan';
import type { CategoryPick } from '../lib/board';
import {
  completedSession,
  deferred,
  makeCategory,
  makeDay,
  makePick,
  makePriority,
  makeRecurring,
  makeSession,
  makeSettings,
  NEW_CATEGORY,
  settle,
  SettingsAndDays,
  T0,
  TODAY,
} from '../test/hooks';
import type { Priority, Recurring, Session } from '../types';
import { Priorities } from './Priorities';
import type { MorningOffer } from './TodayOffer';

vi.mock('../api');
vi.mock('../lib/alerts');

async function renderCard(
  priorities: Priority[] = [],
  leftOpen?: Parameters<typeof Priorities>[0]['leftOpen'],
  sessions: Session[] = [],
  pick: CategoryPick | null = null,
  offer: MorningOffer | null = null,
) {
  const onChange = vi.fn<(p: Priority[], base: Priority[]) => void>();
  const card = (rows: Priority[], o: MorningOffer | null) => (
    <SettingsProvider>
      <Priorities priorities={rows} sessions={sessions} onChange={onChange} pick={pick} leftOpen={leftOpen} offer={o} />
    </SettingsProvider>
  );
  const view = render(card(priorities, offer));
  await settle();
  return {
    ...view,
    onChange,
    saved: () => onChange.mock.lastCall![0],
    /** The card again with these rows, and this offer (the one it had unless given). */
    again: (rows: Priority[], o: MorningOffer | null = offer) => view.rerender(card(rows, o)),
  };
}

/** A row the card pads the list with: nothing ever written in it. */
const blank = (position: number) => makePriority(position, '', { uid: null, addedAt: null });

/** Today's card on the day store, wired as the sheet wires it. */
function OnTheStore({ pick = null }: { pick?: CategoryPick | null }) {
  const { day, store } = useDay(TODAY);
  return day ? (
    <Priorities priorities={day.priorities} sessions={day.sessions} pick={pick} onChange={(p, base) => void store.setPriorities(TODAY, p, base)} />
  ) : null;
}

/**
 * Renders `OnTheStore` against a server that stores each save as the route does (merged with
 * `mergePriorities`) the moment it arrives, and answers it once `answer()` is called.
 */
async function renderOnStore(rows: Priority[], pick: CategoryPick | null = null) {
  let onServer = rows;
  const gate = deferred<void>();
  vi.mocked(api.getDay).mockImplementation(() => Promise.resolve(makeDay(TODAY, { priorities: onServer })));
  vi.mocked(api.putPriorities).mockImplementation(async (_date, list, { base }) => {
    onServer = mergePriorities(onServer, base ?? onServer, list);
    const priorities = onServer;
    await gate.promise;
    return { priorities };
  });
  render(
    <SettingsAndDays>
      <OnTheStore pick={pick} />
    </SettingsAndDays>,
  );
  await settle();
  return {
    stored: () => onServer,
    answer: async () => {
      gate.resolve();
      await settle();
    },
  };
}

const textbox = (n: number) => screen.getByLabelText(`Priority ${n}`) as HTMLTextAreaElement;
const tick = (n: number) => screen.getByLabelText(`Priority ${n} done`) as HTMLInputElement;

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  vi.mocked(api.getSettings).mockResolvedValue(makeSettings());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Priorities', () => {
  it('starts with the configured rows and saves text 400 ms after the last keystroke', async () => {
    const { onChange, saved } = await renderCard();
    expect(screen.getAllByRole('textbox')).toHaveLength(3);
    fireEvent.change(textbox(1), { target: { value: 'Write' } });
    fireEvent.change(textbox(1), { target: { value: 'Write the report' } });
    await settle(399);
    expect(onChange).not.toHaveBeenCalled();
    await settle(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    // The row gets its id and its time the first time it has text.
    expect(saved()[0]).toMatchObject({ position: 1, text: 'Write the report', done: false, addedAt: T0 });
    expect(saved()[0]!.uid).toMatch(/^[0-9a-f]{12}$/);
  });

  it('saves at once when the row is left, and keeps a pasted line break out', async () => {
    const { onChange, saved } = await renderCard();
    fireEvent.change(textbox(2), { target: { value: 'Call\nthe bank' } });
    fireEvent.blur(textbox(2));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(saved()[1]!.text).toBe('Call the bank');
    await settle(400);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('still saves text typed just before the card goes away (another day opened)', async () => {
    const { unmount, onChange, saved } = await renderCard();
    fireEvent.change(textbox(1), { target: { value: 'Typed, then left' } });
    unmount();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(saved()[0]!.text).toBe('Typed, then left');
    await settle(400);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('only ticks a row with text, and saves the tick straight away', async () => {
    const { onChange, saved } = await renderCard([makePriority(1, 'Report')]);
    expect(tick(2).disabled).toBe(true);
    fireEvent.click(tick(1));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(saved()[0]).toMatchObject({ text: 'Report', done: true });
  });

  it('sends each list with the rows it was made on, and the stored rows once it takes them up', async () => {
    const report = makePriority(1, 'Report');
    const { onChange, saved, again } = await renderCard([report]);
    fireEvent.click(tick(1));
    expect(onChange).toHaveBeenCalledExactlyOnceWith([{ ...report, done: true }, blank(2), blank(3)], [report, blank(2), blank(3)]);
    // The store's copy now shows the save, with a row from another device: the card takes it up.
    await settle();
    const stored = [...saved(), makePriority(4, 'From the phone', { uid: 'phone0000000' })];
    again(stored);
    fireEvent.change(textbox(2), { target: { value: 'Email' } });
    fireEvent.blur(textbox(2));
    expect(onChange.mock.lastCall![1]).toEqual(stored);
  });

  it('celebrates a tick from its box with the priority sound, and not an untick', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(makeSettings({ sounds: { ...makeSettings().sounds, priorityDone: 'pop' } }));
    await renderCard([makePriority(1, 'Report'), makePriority(2, 'Invoices', { done: true })]);
    fireEvent.click(tick(1));
    // The sound plays after the render, so the tap unlocks audio for iOS first.
    expect(unlockAudio).toHaveBeenCalled();
    expect(playSound).toHaveBeenCalledExactlyOnceWith('pop');
    expect(document.querySelector('.burst')).not.toBeNull();
    fireEvent.click(tick(2));
    expect(playSound).toHaveBeenCalledTimes(1);
  });

  it('sends Add priority to the first empty row, with no warning and nothing saved', async () => {
    const { onChange } = await renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Add priority' }));
    expect(screen.getByRole('status').textContent).toBe('');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getAllByRole('textbox')).toHaveLength(3);
    expect(document.activeElement).toBe(textbox(1));
  });

  it('finds an empty row between written ones', async () => {
    await renderCard([makePriority(1, 'A'), makePriority(3, 'C')]);
    fireEvent.click(screen.getByRole('button', { name: 'Add priority' }));
    expect(document.activeElement).toBe(textbox(2));
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('asks before a row past the usual count, then adds it; the extra row can be removed', async () => {
    const { onChange, saved } = await renderCard([makePriority(1, 'Report'), makePriority(2, 'Invoices'), makePriority(3, 'Email')]);
    expect(screen.getByRole('status').textContent).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Add priority' }));
    expect(onChange).not.toHaveBeenCalled();
    // The live region is there before the warning, so a screen reader hears it arrive.
    const status = screen.getByRole('status');
    expect(PRIORITY_WARNINGS.fresh.some((w) => status.textContent!.includes(w))).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: WARNING_ACTIONS.fresh.keep }));
    expect(screen.getByRole('status')).toBe(status);
    expect(status.textContent).toBe('');
    // The notice took its buttons with it, so focus goes to Add priority rather than the page.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add priority' }));

    fireEvent.click(screen.getByRole('button', { name: 'Add priority' }));
    fireEvent.click(screen.getByRole('button', { name: WARNING_ACTIONS.fresh.add }));
    expect(saved()).toHaveLength(4);
    expect(screen.getAllByRole('textbox')).toHaveLength(4);
    expect(document.activeElement).toBe(textbox(4));

    fireEvent.click(screen.getByRole('button', { name: 'Remove priority 4' }));
    expect(saved()).toHaveLength(3);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add priority' }));
    // Rows inside the usual count have no remove button.
    expect(screen.queryByRole('button', { name: /Remove priority/ })).toBeNull();
  });

  it('keeps focus on a remove button when a row before the last is removed', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(makeSettings({ priorityCount: 1 }));
    const { saved } = await renderCard([makePriority(1, 'A'), makePriority(2, 'B'), makePriority(3, 'C')]);
    const remove2 = screen.getByRole('button', { name: 'Remove priority 2' });
    remove2.focus();
    fireEvent.click(remove2);
    expect(saved().map((p) => p.text)).toEqual(['A', 'C']);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove priority 2' }));
  });

  it('with every row ticked, warns from the "complete" set and lists what is done', async () => {
    await renderCard([makePriority(1, 'Report', { done: true }), makePriority(2, 'Invoices', { done: true }), makePriority(3, 'Email', { done: true })]);
    fireEvent.click(screen.getByRole('button', { name: 'Add priority' }));
    const status = screen.getByRole('status');
    expect(PRIORITY_WARNINGS.complete.some((w) => status.textContent!.includes(w))).toBe(true);
    expect(status.textContent).toContain('3 of 3 done');
    expect(screen.getByRole('button', { name: WARNING_ACTIONS.complete.add })).toBeTruthy();
  });

  it("offers the last plan's open rows on an empty list, as new rows for today", async () => {
    const dismiss = vi.fn();
    // The same row written twice on the last plan, both added the day before.
    const yesterdays = [makePriority(2, 'Invoices', { addedAt: T0 - DAY_MS }), makePriority(3, 'invoices ', { addedAt: T0 - DAY_MS })];
    const { saved } = await renderCard([], { from: 'yesterday', rows: yesterdays, dismiss });
    expect(screen.getByText(LEFT_OPEN.title('yesterday'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: LEFT_OPEN.dismiss }));
    expect(dismiss).toHaveBeenCalled();
    expect(document.activeElement).toBe(textbox(1));
    fireEvent.click(screen.getByRole('button', { name: LEFT_OPEN.add }));
    expect(saved().map((p) => p.text)).toEqual(['Invoices', '', '']);
    // The offer is gone with its buttons; focus lands on the row it filled.
    expect(screen.queryByRole('button', { name: LEFT_OPEN.add })).toBeNull();
    expect(document.activeElement).toBe(textbox(1));
    expect(saved()[0]).toMatchObject({ position: 1, text: 'Invoices', done: false, addedAt: T0 });
    expect(saved()[0]!.uid).not.toBe(yesterdays[0]!.uid);
  });

  it("brings each left-open row over as the same task: today's own row, with its card and category", async () => {
    const yesterdays = [makePriority(2, 'Invoices', { addedAt: T0 - DAY_MS, cardUid: 'card00000001', categoryUid: 'cafe00000001' })];
    const { saved } = await renderCard([], { from: 'yesterday', rows: yesterdays, dismiss: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: LEFT_OPEN.add }));
    expect(saved()[0]).toMatchObject({ position: 1, text: 'Invoices', addedAt: T0, cardUid: 'card00000001', recurringUid: null, categoryUid: 'cafe00000001' });
    expect(saved()[0]!.uid).not.toBe(yesterdays[0]!.uid);
  });
});

describe("Priorities: a row's category", () => {
  const TICKETS = makeCategory('cat000000001', 'Tickets');
  const ADMIN = makeCategory('cat000000002', 'Admin', { color: 'teal' });
  const chip = (n: number) => screen.queryByRole('button', { name: new RegExp(`^Category for priority ${n}:`) });
  const option = (name: string) => screen.getByRole('option', { name });
  /** The card with the board on: the chip's data over Tickets and Admin, unless given. */
  const withPick = (rows: Priority[], pick: CategoryPick = makePick([TICKETS, ADMIN])) => renderCard(rows, undefined, [], pick);

  it('puts a chip at the end of each row with text while the board is on, and none on an empty row', async () => {
    await withPick([makePriority(1, 'Report', { categoryUid: TICKETS.uid }), makePriority(2, 'Email')]);
    expect(chip(1)!.getAttribute('aria-label')).toBe('Category for priority 1: Tickets');
    expect(chip(2)!.getAttribute('aria-label')).toBe('Category for priority 2: none');
    expect(chip(3)).toBeNull();
    const rows = [...document.querySelectorAll('.priority-row')];
    // Tick, text, then chip.
    expect([...rows[0]!.querySelectorAll('input, textarea, button')].map((el) => el.getAttribute('aria-label'))).toEqual([
      'Priority 1 done',
      'Priority 1',
      'Category for priority 1: Tickets',
    ]);
  });

  it("gives every row the chip's column while the board is on, an empty one with no chip included", async () => {
    const rows = [makePriority(1, 'A'), makePriority(2, 'B'), makePriority(3, 'C'), blank(4)];
    await withPick(rows);
    const shown = [...document.querySelectorAll('.priority-row')];
    expect(shown.map((r) => r.classList.contains('priority-row--end'))).toEqual([true, true, true, true]);
    // The empty row past the usual count: the column, its ×, and no chip.
    expect(chip(4)).toBeNull();
    expect(shown[3]!.querySelector('.priority-end')).toBeNull();
    expect(shown[3]!.className).toContain('priority-row--removable');
    expect(screen.getByRole('button', { name: 'Remove priority 4' })).toBeTruthy();
  });

  it('shows no chip and no chip column with the board off', async () => {
    await renderCard([makePriority(1, 'Report', { categoryUid: TICKETS.uid }), blank(2), blank(3), blank(4)]);
    expect(chip(1)).toBeNull();
    expect(document.querySelectorAll('.priority-row')).toHaveLength(4);
    expect(document.querySelector('.priority-row--end')).toBeNull();
  });

  it('puts the chip before the × on a row past the usual count', async () => {
    const rows = [makePriority(1, 'A'), makePriority(2, 'B'), makePriority(3, 'C'), makePriority(4, 'D')];
    await withPick(rows);
    const row = document.querySelectorAll('.priority-row')[3]!;
    expect(row.className).toContain('priority-row--end');
    expect(row.className).toContain('priority-row--removable');
    expect([...row.querySelectorAll('textarea, button')].map((el) => el.getAttribute('aria-label'))).toEqual([
      'Priority 4',
      'Category for priority 4: none',
      'Remove priority 4',
    ]);
  });

  it('saves a pick at once, with the text typed before it', async () => {
    const { onChange, saved } = await withPick([makePriority(1, 'Report')]);
    act(() => textbox(1).focus());
    fireEvent.change(textbox(1), { target: { value: 'Report for Acme' } });
    // The list takes the focus from the field as it opens, which saves the text, as any blur does.
    fireEvent.click(chip(1)!);
    fireEvent.click(option('Admin'));
    expect(saved()[0]).toMatchObject({ text: 'Report for Acme', categoryUid: ADMIN.uid });
    expect(chip(1)!.getAttribute('aria-label')).toBe('Category for priority 1: Admin');
    // Nothing waited on the debounce.
    const sent = onChange.mock.calls.length;
    await settle(400);
    expect(onChange).toHaveBeenCalledTimes(sent);
  });

  it('files a pick under the row whose chip made it, leaving the others as they were', async () => {
    const { saved } = await withPick([makePriority(1, 'Report', { categoryUid: TICKETS.uid }), makePriority(2, 'Email')]);
    fireEvent.click(chip(2)!);
    fireEvent.click(option('Admin'));
    expect(saved().map((p) => [p.text, p.categoryUid])).toEqual([
      ['Report', TICKETS.uid],
      ['Email', ADMIN.uid],
      ['', null],
    ]);
    expect(chip(2)!.getAttribute('aria-label')).toBe('Category for priority 2: Admin');
    expect(chip(1)!.getAttribute('aria-label')).toBe('Category for priority 1: Tickets');
  });

  it("closes a row's list when another device's change moves a different row to its place", async () => {
    const report = makePriority(1, 'Report');
    const email = makePriority(2, 'Email');
    const { again, onChange } = await withPick([report, email]);
    fireEvent.click(chip(2)!);
    expect(screen.getByRole('listbox')).toBeTruthy();
    // The phone removed the report: the email moves up, and an invoice row comes in second.
    again([{ ...email, position: 1 }, makePriority(2, 'Invoices', { uid: 'invoices0000' })]);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(chip(2)!.getAttribute('aria-label')).toBe('Category for priority 2: none');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('takes a category made in the chip on the row, and clears one with No category', async () => {
    const pick = makePick([TICKETS]);
    const { saved } = await withPick([makePriority(1, 'Report', { categoryUid: TICKETS.uid })], pick);
    fireEvent.click(chip(1)!);
    fireEvent.click(option('No category'));
    expect(saved()[0]!.categoryUid).toBeNull();
    fireEvent.click(chip(1)!);
    const box = screen.getByRole('textbox', { name: 'New category' });
    fireEvent.change(box, { target: { value: 'Follow-ups' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(pick.create).toHaveBeenCalledWith('Follow-ups');
    expect(saved()[0]!.categoryUid).toBe(NEW_CATEGORY);
  });

  it('sends a pick through the day store as a change from the rows it was made on, and the server keeps it', async () => {
    const report = makePriority(1, 'Report');
    const { stored, answer } = await renderOnStore([report], makePick([TICKETS]));
    fireEvent.click(chip(1)!);
    fireEvent.click(option('Tickets'));
    expect(api.putPriorities).toHaveBeenCalledTimes(1);
    const [, list, { base }] = vi.mocked(api.putPriorities).mock.lastCall!;
    expect(list[0]).toMatchObject({ uid: report.uid, categoryUid: TICKETS.uid });
    expect(base?.[0]).toMatchObject({ uid: report.uid, categoryUid: null });
    await answer();
    expect(stored()[0]).toMatchObject({ uid: report.uid, categoryUid: TICKETS.uid });
    expect(chip(1)!.getAttribute('aria-label')).toBe('Category for priority 1: Tickets');
  });

  it('keeps the category on a cleared row, which shows it again once written in', async () => {
    const { saved } = await withPick([makePriority(1, 'Report', { categoryUid: TICKETS.uid })]);
    fireEvent.change(textbox(1), { target: { value: '' } });
    fireEvent.blur(textbox(1));
    expect(saved()[0]).toMatchObject({ text: '', uid: makePriority(1, '').uid, categoryUid: TICKETS.uid });
    expect(chip(1)).toBeNull();
    fireEvent.change(textbox(1), { target: { value: 'Report, take two' } });
    expect(chip(1)!.getAttribute('aria-label')).toBe('Category for priority 1: Tickets');
  });
});

/** A row carried from the last plan, linked to nothing unless patched. */
const seed = (text: string, patch: Partial<PrioritySeed> = {}): PrioritySeed => ({ text, cardUid: null, recurringUid: null, categoryUid: null, ...patch });

const QUEUE = makeRecurring('rcur00000001', 'Monitor the queue', { categoryUid: 'cafe00000001' });
const FOLLOW_UPS = makeRecurring('rcur00000002', 'Follow-ups');
const STANDUP = makeRecurring('rcur00000003', 'Standup notes');
/** A row of today's list added from `item`, with text unless given ''. */
const routineRow = (position: number, item: Recurring, text = item.title, patch: Partial<Priority> = {}) =>
  makePriority(position, text, { recurringUid: item.uid, categoryUid: item.categoryUid, ...patch });

describe('Priorities: the left-open block, with the board off', () => {
  it('lists the seeds it is given and brings them over as written: a card under its title, the same card', async () => {
    const seeds = [
      { text: 'Retitled on the board', cardUid: 'card00000001', recurringUid: null, categoryUid: null },
      { text: 'No card', cardUid: null, recurringUid: null, categoryUid: 'cafe00000001' },
    ];
    const { saved } = await renderCard([], { from: 'yesterday', rows: seeds, dismiss: vi.fn() });
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Retitled on the board', 'No card']);
    fireEvent.click(screen.getByRole('button', { name: LEFT_OPEN.add }));
    expect(saved().map((p) => [p.text, p.cardUid, p.categoryUid])).toEqual([
      ['Retitled on the board', 'card00000001', null],
      ['No card', null, 'cafe00000001'],
      ['', null, null],
    ]);
  });

  it('shows while the list holds only routines, and goes once a one-off is written', async () => {
    const rows = [makePriority(1, 'Monitor the queue', { recurringUid: 'rcur00000001', done: true })];
    await renderCard(rows, { from: 'yesterday', rows: [seed('Invoices')], dismiss: vi.fn() });
    expect(screen.getByText(LEFT_OPEN.title('yesterday'))).toBeTruthy();
    expect(document.querySelector('.today-offer')).toBeNull();
    fireEvent.change(textbox(2), { target: { value: 'Call the bank' } });
    expect(screen.queryByText(LEFT_OPEN.title('yesterday'))).toBeNull();
  });

  it('puts the focus on the first row left free when it fills none, as the rows stand after the save', async () => {
    // The routine's text: the leftover comes over once, and the routine moves up to row 1.
    const routine = makePriority(2, 'Invoices', { recurringUid: 'rcur00000001' });
    const { saved } = await renderCard([blank(1), routine], { from: 'yesterday', rows: [seed('Invoices')], dismiss: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: LEFT_OPEN.add }));
    expect(saved().map((p) => p.text)).toEqual(['Invoices', '', '']);
    expect(document.activeElement).toBe(textbox(2));
  });

  it('puts the focus on the row it filled, past a routine kept ahead of it', async () => {
    const routine = makePriority(1, 'Monitor the queue', { recurringUid: 'rcur00000001' });
    const { saved } = await renderCard([routine], { from: 'yesterday', rows: [seed('Invoices')], dismiss: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: LEFT_OPEN.add }));
    expect(saved().map((p) => p.text)).toEqual(['Monitor the queue', 'Invoices', '']);
    expect(document.activeElement).toBe(textbox(2));
  });
});

describe('Priorities: the morning offer, with the board on', () => {
  const offerOf = (patch: Partial<MorningOffer> = {}): MorningOffer => ({ leftovers: null, recurring: [], answer: vi.fn(), ...patch });
  /** The leftovers group as the sheet hands it down, from yesterday. */
  const left = (rows: PrioritySeed[]) => ({ from: 'yesterday', rows });
  const withOffer = (rows: Priority[], offer: MorningOffer) => renderCard(rows, undefined, [], null, offer);
  const box = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement;
  const ticks = (...names: string[]) => names.map((n) => box(n).checked);
  const over = () => document.querySelector('.today-offer [role="status"]')!.textContent;
  const perDay = (n: number) => vi.mocked(api.getSettings).mockResolvedValue(makeSettings({ recurringPerDay: n }));
  const shown = () => [...document.querySelectorAll('.today-offer li')].map((li) => li.textContent);

  it('shows the leftovers and the routines due in one notice, the leftovers ticked and the routines up to Recurring rows per day', async () => {
    perDay(2);
    const offer = offerOf({ leftovers: left([seed('Invoices'), seed('Email')]), recurring: [QUEUE, FOLLOW_UPS, STANDUP] });
    await withOffer([], offer);
    const notice = document.querySelector('.today-offer')!;
    expect([...notice.querySelectorAll('strong')].map((h) => h.textContent)).toEqual([LEFT_OPEN.title('yesterday'), TODAY_OFFER.recurring]);
    expect(ticks('Invoices', 'Email', 'Monitor the queue', 'Follow-ups', 'Standup notes')).toEqual([true, true, true, true, false]);
    expect(over()).toBe('');
    expect(screen.getByRole('button', { name: TODAY_OFFER.notToday })).toBeTruthy();
    expect(screen.queryByRole('button', { name: LEFT_OPEN.dismiss })).toBeNull();
  });

  it('ticks fewer routines for those already on the list, and drops a leftover that comes twice', async () => {
    perDay(2);
    const onList = routineRow(1, makeRecurring('rcur00000009', 'Weekly report'));
    const leftovers = [seed('Invoices', { cardUid: 'card00000001' }), seed('Invoices, again', { cardUid: 'card00000001' }), seed('Email'), seed('Email')];
    // An emptied routine row isn't on the list: it doesn't count.
    await withOffer([onList, routineRow(2, STANDUP, '')], offerOf({ leftovers: left(leftovers), recurring: [QUEUE, FOLLOW_UPS] }));
    expect(ticks('Monitor the queue', 'Follow-ups')).toEqual([true, false]);
    expect(shown()).toEqual(['Invoices', 'Email', 'Monitor the queue', 'Follow-ups']);
  });

  it('says so while more routines are ticked than Recurring rows per day, and adds them all the same', async () => {
    perDay(2);
    const { saved } = await withOffer([], offerOf({ recurring: [QUEUE, FOLLOW_UPS, STANDUP] }));
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
    expect(saved().map((p) => p.recurringUid)).toEqual([null, null, null, QUEUE.uid, FOLLOW_UPS.uid, STANDUP.uid]);
  });

  it('counts the routines on the list toward the line', async () => {
    perDay(1);
    await withOffer([routineRow(1, STANDUP)], offerOf({ recurring: [QUEUE] }));
    expect(ticks('Monitor the queue')).toEqual([false]);
    expect(over()).toBe('');
    fireEvent.click(box('Monitor the queue'));
    expect(over()).toBe(TODAY_OFFER.over(1));
  });

  it('counts a routine row typed into on the draft at once, before it saves, toward the ticks and the line', async () => {
    perDay(1);
    await withOffer([routineRow(1, STANDUP, '')], offerOf({ recurring: [QUEUE] }));
    expect(ticks('Monitor the queue')).toEqual([true]);
    fireEvent.change(textbox(1), { target: { value: 'Standup' } });
    expect(ticks('Monitor the queue')).toEqual([false]);
    fireEvent.click(box('Monitor the queue'));
    expect(over()).toBe(TODAY_OFFER.over(1));
  });

  it('adds what is ticked in one save, the leftovers first and the routines after the padded rows, and answers every item shown', async () => {
    perDay(2);
    const answer = vi.fn();
    const leftovers = [seed('Invoices', { cardUid: 'card00000001' }), seed('Email')];
    const { onChange, saved } = await withOffer([], offerOf({ leftovers: left(leftovers), recurring: [QUEUE, FOLLOW_UPS, STANDUP], answer }));
    fireEvent.click(box('Email'));
    fireEvent.click(screen.getByRole('button', { name: LEFT_OPEN.add }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(saved().map((p) => [p.position, p.text, p.cardUid, p.recurringUid])).toEqual([
      [1, 'Invoices', 'card00000001', null],
      [2, '', null, null],
      [3, '', null, null],
      [4, 'Monitor the queue', null, QUEUE.uid],
      [5, 'Follow-ups', null, FOLLOW_UPS.uid],
    ]);
    expect(saved()[3]).toMatchObject({ addedAt: T0, categoryUid: QUEUE.categoryUid });
    // Standup notes was shown and left unticked: answered all the same.
    expect(answer).toHaveBeenCalledExactlyOnceWith([QUEUE.uid, FOLLOW_UPS.uid, STANDUP.uid], true);
    expect(document.activeElement).toBe(textbox(1));
    // The leftovers go with the one-off written, and the routines added with their rows; the sheet
    // then hands down no Standup notes, answered (the Sheet tests).
    expect(shown()).toEqual(['Standup notes']);
  });

  it('puts the focus on the first row Add filled: an emptied routine row taken back', async () => {
    const emptied = routineRow(2, QUEUE, '', { uid: 'emptied00001', addedAt: 50 });
    const { saved } = await withOffer([makePriority(1, 'Report'), emptied], offerOf({ recurring: [QUEUE, FOLLOW_UPS] }));
    fireEvent.click(screen.getByRole('button', { name: LEFT_OPEN.add }));
    expect(saved().map((p) => [p.text, p.uid])).toEqual([
      ['Report', makePriority(1, '').uid],
      ['Monitor the queue', 'emptied00001'],
      ['', null],
      ['Follow-ups', saved()[3]!.uid],
    ]);
    expect(document.activeElement).toBe(textbox(2));
  });

  it('puts the focus on a routine Add put after the padded rows, a row the card had not drawn yet', async () => {
    await withOffer([], offerOf({ recurring: [QUEUE] }));
    fireEvent.click(screen.getByRole('button', { name: LEFT_OPEN.add }));
    expect(document.activeElement).toBe(textbox(4));
  });

  it('with nothing ticked, adds no row, answers every item shown and puts the focus where a new priority goes', async () => {
    const answer = vi.fn();
    const { saved } = await withOffer(
      [makePriority(1, ''), blank(2), makePriority(3, 'Monitor the queue', { recurringUid: 'rcur00000009' })],
      offerOf({ recurring: [QUEUE], answer }),
    );
    fireEvent.click(box('Monitor the queue'));
    fireEvent.click(screen.getByRole('button', { name: LEFT_OPEN.add }));
    expect(saved().map((p) => p.text)).toEqual(['', '', 'Monitor the queue']);
    expect(answer).toHaveBeenCalledExactlyOnceWith([QUEUE.uid], false);
    expect(document.activeElement).toBe(textbox(2));
  });

  it('answers every item shown with Not today, saving nothing, and puts the focus where a new priority goes', async () => {
    const answer = vi.fn();
    const leftovers = [seed('Invoices')];
    const { onChange } = await withOffer([makePriority(1, '')], offerOf({ leftovers: left(leftovers), recurring: [QUEUE, FOLLOW_UPS], answer }));
    fireEvent.click(box('Follow-ups'));
    fireEvent.click(screen.getByRole('button', { name: TODAY_OFFER.notToday }));
    expect(answer).toHaveBeenCalledExactlyOnceWith([QUEUE.uid, FOLLOW_UPS.uid], true);
    expect(onChange).not.toHaveBeenCalled();
    // Past the cleared row, which is still its old item.
    expect(document.activeElement).toBe(textbox(2));
  });

  it('is Start fresh with only leftovers shown, and answers no routine', async () => {
    const answer = vi.fn();
    const cleared = [1, 2, 3].map((n) => makePriority(n, ''));
    await withOffer(cleared, offerOf({ leftovers: left([seed('Invoices')]), answer }));
    expect(screen.queryByRole('button', { name: TODAY_OFFER.notToday })).toBeNull();
    expect(screen.queryByText(TODAY_OFFER.recurring)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: LEFT_OPEN.dismiss }));
    expect(answer).toHaveBeenCalledExactlyOnceWith([], true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add priority' }));
  });

  it('shows the routines alone once a one-off is written, the leftovers going at the first key', async () => {
    const answer = vi.fn();
    await withOffer([], offerOf({ leftovers: left([seed('Invoices')]), recurring: [QUEUE], answer }));
    fireEvent.change(textbox(1), { target: { value: 'C' } });
    expect(screen.queryByText(LEFT_OPEN.title('yesterday'))).toBeNull();
    expect(shown()).toEqual(['Monitor the queue']);
    fireEvent.click(screen.getByRole('button', { name: TODAY_OFFER.notToday }));
    expect(answer).toHaveBeenCalledExactlyOnceWith([QUEUE.uid], false);
  });

  it('keeps the leftovers while the list holds only routines, and drops a routine a row with text holds, answering only those shown', async () => {
    const answer = vi.fn();
    await withOffer([routineRow(1, QUEUE)], offerOf({ leftovers: left([seed('Invoices')]), recurring: [QUEUE, FOLLOW_UPS], answer }));
    expect(screen.getByText(LEFT_OPEN.title('yesterday'))).toBeTruthy();
    expect(shown()).toEqual(['Invoices', 'Follow-ups']);
    // The queue's row could still be emptied or removed today, and the notice offer it again.
    fireEvent.click(screen.getByRole('button', { name: TODAY_OFFER.notToday }));
    expect(answer).toHaveBeenCalledExactlyOnceWith([FOLLOW_UPS.uid], true);
  });

  it('shows nothing with every routine on the list and no leftover, and comes back for an item read later', async () => {
    const { again } = await withOffer([routineRow(1, QUEUE)], offerOf({ recurring: [QUEUE] }));
    expect(document.querySelector('.today-offer')).toBeNull();
    again([routineRow(1, QUEUE)], offerOf({ recurring: [QUEUE, FOLLOW_UPS] }));
    expect(ticks('Follow-ups')).toEqual([true]);
  });
});

describe('Priorities: routines on the list', () => {
  it('leaves the routines out of the nudge: three routines and two one-offs add a row with no warning', async () => {
    const rows = [routineRow(1, QUEUE), routineRow(2, FOLLOW_UPS), routineRow(3, STANDUP), makePriority(4, 'Report'), makePriority(5, 'Email')];
    const { saved } = await renderCard(rows);
    fireEvent.click(screen.getByRole('button', { name: 'Add priority' }));
    expect(screen.getByRole('status').textContent).toBe('');
    expect(saved()).toHaveLength(6);
    expect(document.activeElement).toBe(textbox(6));
  });

  it('marks a written routine row before its chip while the board is on, ticked or not, and no other row', async () => {
    const rows = [routineRow(1, QUEUE), routineRow(2, FOLLOW_UPS, 'Follow-ups', { done: true }), makePriority(3, 'Report'), routineRow(4, STANDUP, '')];
    await renderCard(rows, undefined, [], makePick());
    const ends = [...document.querySelectorAll('.priority-row')].map((r) => [...(r.querySelector('.priority-end')?.children ?? [])].map((el) => el.className));
    expect(ends).toEqual([['repeat-mark', 'category-wrap'], ['repeat-mark', 'category-wrap'], ['category-wrap'], []]);
    expect(screen.getAllByRole('img', { name: 'Repeats' })).toHaveLength(2);
  });

  it('shows no mark with the board off', async () => {
    await renderCard([routineRow(1, QUEUE)]);
    expect(screen.queryByRole('img', { name: 'Repeats' })).toBeNull();
  });

  describe('an emptied routine row', () => {
    const note = () => screen.queryByText(EMPTIED_RECURRING);

    it("says it is still the routine, as the field's description, until a key is typed: with no time logged too", async () => {
      await renderCard([routineRow(1, QUEUE), makePriority(2, 'Report')]);
      expect(note()).toBeNull();
      fireEvent.change(textbox(1), { target: { value: '' } });
      expect(note()).not.toBeNull();
      expect(textbox(1).getAttribute('aria-describedby')).toBe(note()!.id);
      fireEvent.change(textbox(1), { target: { value: 'Q' } });
      expect(note()).toBeNull();
      expect(textbox(1).hasAttribute('aria-describedby')).toBe(false);
    });

    it('says it in place of the note on the time logged, with the board on or off', async () => {
      const sessions = [completedSession(1, T0, 25 * 60, { priorityUid: makePriority(1, '').uid })];
      for (const pick of [null, makePick()]) {
        const { unmount } = await renderCard([routineRow(1, QUEUE, ''), makePriority(2, 'Report')], undefined, sessions, pick);
        expect(note()).not.toBeNull();
        expect(screen.queryByText(EMPTIED_ROW('25m'))).toBeNull();
        expect(document.querySelectorAll('.priority-held')).toHaveLength(1);
        unmount();
      }
    });
  });
});

describe('Priorities: a cleared row', () => {
  const written = () => [makePriority(1, 'Report'), makePriority(2, 'Invoices'), makePriority(3, 'Email')];
  /** 25 minutes logged on row 2. */
  const logged = (patch: Parameters<typeof completedSession>[3] = {}) => completedSession(1, T0, 25 * 60, { priorityUid: makePriority(2, '').uid, ...patch });
  const note = () => screen.queryByText(EMPTIED_ROW('25m'));

  it("says the time logged on it stays with it, as the field's description, until a key is typed", async () => {
    await renderCard(written(), undefined, [logged()]);
    expect(note()).toBeNull();
    fireEvent.change(textbox(2), { target: { value: '' } });
    expect(note()).not.toBeNull();
    expect(textbox(2).getAttribute('aria-describedby')).toBe(note()!.id);
    // The same item, renamed: the first key takes the note and the field's description away.
    fireEvent.change(textbox(2), { target: { value: 'C' } });
    expect(note()).toBeNull();
    expect(textbox(2).hasAttribute('aria-describedby')).toBe(false);
  });

  it('shows on a row stored empty, and adds up every completed session on it', async () => {
    const uid = makePriority(2, '').uid;
    const sessions = [completedSession(1, T0, 10 * 60, { priorityUid: uid }), completedSession(2, T0 + 1, 15 * 60, { priorityUid: uid })];
    await renderCard([makePriority(1, 'Report'), makePriority(2, ''), makePriority(3, 'Email')], undefined, sessions);
    expect(note()).not.toBeNull();
  });

  it('names no amount for less than a minute, rather than 0m', async () => {
    // Finish pressed 30 s in logs the 30 s.
    const early = logged({ endedAt: T0 + 30 * 1000, durationSeconds: 30 });
    await renderCard([makePriority(1, 'Report'), makePriority(2, ''), makePriority(3, 'Email')], undefined, [early]);
    expect(screen.queryByText(EMPTIED_ROW(null))).not.toBeNull();
    expect(screen.queryByText(EMPTIED_ROW('0m'))).toBeNull();
  });

  it('says nothing for a row with no time logged on it, only a running or cancelled session, or one never written in', async () => {
    const uid = makePriority(2, '').uid;
    const sessions: Session[] = [
      makeSession({ id: 1, priorityUid: uid }),
      logged({ id: 2, status: 'cancelled' }),
      completedSession(3, T0, 25 * 60, { priorityUid: makePriority(1, '').uid }),
      completedSession(4, T0, 25 * 60),
    ];
    await renderCard([makePriority(1, 'Report'), makePriority(2, ''), makePriority(3, '', { uid: null, addedAt: null })], undefined, sessions);
    expect(document.querySelector('.priority-held')).toBeNull();
    expect(textbox(2).hasAttribute('aria-describedby')).toBe(false);
  });

  it('is passed by Add priority, which adds a row past it with no nudge while two rows have text', async () => {
    const cleared = makePriority(2, '');
    const { saved } = await renderCard([makePriority(1, 'Report'), cleared, makePriority(3, 'Email')], undefined, [logged()]);
    fireEvent.click(screen.getByRole('button', { name: 'Add priority' }));
    expect(screen.getByRole('status').textContent).toBe('');
    expect(saved()).toHaveLength(4);
    expect(saved()[1]).toEqual(cleared);
    expect(document.activeElement).toBe(textbox(4));
    expect(note()).not.toBeNull();
  });

  it('is passed by Start fresh, which focuses the first row never written in, else Add priority', async () => {
    const offer = { from: 'yesterday', rows: [makePriority(2, 'Invoices', { addedAt: T0 - DAY_MS })], dismiss: vi.fn() };
    const { again } = await renderCard([makePriority(1, '')], offer, [logged()]);
    fireEvent.click(screen.getByRole('button', { name: LEFT_OPEN.dismiss }));
    expect(offer.dismiss).toHaveBeenCalled();
    expect(document.activeElement).toBe(textbox(2));
    // Every row cleared: the next row is one Add priority makes.
    again([makePriority(1, ''), makePriority(2, ''), makePriority(3, '')]);
    fireEvent.click(screen.getByRole('button', { name: LEFT_OPEN.dismiss }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add priority' }));
  });

  it("stays when the last plan's open rows are added after it", async () => {
    const cleared = makePriority(1, '');
    const offer = { from: 'yesterday', rows: [makePriority(2, 'Invoices', { addedAt: T0 - DAY_MS })], dismiss: vi.fn() };
    const { saved } = await renderCard([cleared], offer);
    fireEvent.click(screen.getByRole('button', { name: LEFT_OPEN.add }));
    expect(saved().map((p) => p.text)).toEqual(['', 'Invoices', '']);
    expect(saved()[0]).toEqual(cleared);
    expect(saved()[1]!.uid).not.toBe(cleared.uid);
    // Focus lands on the row the offer filled.
    expect(document.activeElement).toBe(textbox(2));
  });

  it('is taken back by the left-open row whose card it holds, with its uid and the time logged on it', async () => {
    const cleared = makePriority(2, '', { cardUid: 'card00000001' });
    const rows = [
      makePriority(1, 'Invoices', { uid: 'monday000001', addedAt: T0 - DAY_MS, cardUid: 'card00000001' }),
      makePriority(2, 'Email', { uid: 'monday000002', addedAt: T0 - DAY_MS }),
    ];
    const { saved } = await renderCard([makePriority(1, '', { uid: null, addedAt: null }), cleared], { from: 'yesterday', rows, dismiss: vi.fn() }, [logged()]);
    expect(note()).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: LEFT_OPEN.add }));
    expect(saved().map((p) => [p.position, p.text, p.uid, p.cardUid])).toEqual([
      [1, 'Invoices', cleared.uid, 'card00000001'],
      [2, 'Email', saved()[1]!.uid, null],
      [3, '', null, null],
    ]);
    expect(saved()[1]!.uid).not.toBe('monday000002');
    expect(note()).toBeNull();
    expect(document.activeElement).toBe(textbox(1));
  });
});

describe('Priorities on the day store', () => {
  it('sends an untick made before the tick is answered as a change from the tick', async () => {
    const { stored, answer } = await renderOnStore([makePriority(1, 'Report')]);
    fireEvent.click(tick(1));
    await settle();
    fireEvent.click(tick(1));
    await answer();
    const sent = vi.mocked(api.putPriorities).mock.calls.map(([, list, { base }]) => [list[0]!.done, base![0]!.done]);
    expect(sent).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(stored()[0]!.done).toBe(false);
    expect(tick(1).checked).toBe(false);
  });

  it('keeps a row removed when its text was saved on the way out of it and not answered yet', async () => {
    const rows = [makePriority(1, 'Report'), makePriority(2, 'Invoices'), makePriority(3, 'Email'), blank(4)];
    const { stored, answer } = await renderOnStore(rows);
    fireEvent.change(textbox(4), { target: { value: 'Call the bank' } });
    fireEvent.blur(textbox(4));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Remove priority 4' }));
    await answer();
    expect(stored().map((p) => p.text)).toEqual(['Report', 'Invoices', 'Email']);
    expect(screen.queryByLabelText('Priority 4')).toBeNull();
  });
});
