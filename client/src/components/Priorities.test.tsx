// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MINUTE_MS } from '../../../shared/dates.js';
import { MAX_PRIORITIES } from '../../../shared/settings.js';
import { mergePriorities } from '../../../shared/priorities.js';
import * as api from '../api';
import { useDay } from '../hooks/useDay';
import { SettingsProvider } from '../hooks/useSettings';
import { useBoardStore } from '../hooks/useBoard';
import { playSound, unlockAudio, warnSaveFailed } from '../lib/alerts';
import { BLANK_HINT, LEFT_OPEN, PRIORITY_WARNINGS, REMOVE_TASK, RENAME_HINT, TODAY_OFFER, WARNING_ACTIONS } from '../lib/copy';
import type { PrioritySeed } from '../lib/plan';
import { emptyRow } from '../lib/priorities';
import type { CategoryPick } from '../lib/board';
import {
  answered,
  completedSession,
  deferred,
  makeBoard,
  makeCategory,
  makeDay,
  makePick,
  makePriority,
  makeRecurring,
  makeSession,
  makeSettings,
  NEW_CATEGORY,
  pressKey,
  rowUid,
  settle,
  SettingsAndDays,
  ShortcutKeys,
  T0,
  TODAY,
} from '../test/hooks';
import type { Priority, Recurring, Session } from '../types';
import { Priorities } from './Priorities';
import type { MorningOffer } from './TodayOffer';

vi.mock('../api');
vi.mock('../lib/alerts');

async function renderCard(priorities: Priority[] = [], sessions: Session[] = [], pick: CategoryPick | null = null, offer: MorningOffer | null = null) {
  const onChange = vi.fn<(p: Priority[], base: Priority[]) => Promise<boolean>>(() => Promise.resolve(true));
  const onDeleteTask = vi.fn<(uid: string) => Promise<void>>(() => Promise.resolve());
  const onNote = vi.fn<(uid: string, note: string) => Promise<boolean>>(() => Promise.resolve(true));
  const card = (rows: Priority[], o: MorningOffer | null) => (
    <SettingsProvider>
      <ShortcutKeys />
      <Priorities priorities={rows} sessions={sessions} now={T0} onChange={onChange} onDeleteTask={onDeleteTask} onNote={onNote} pick={pick} offer={o} />
    </SettingsProvider>
  );
  const view = render(card(priorities, offer));
  await settle();
  return {
    ...view,
    onChange,
    onDeleteTask,
    onNote,
    saved: () => onChange.mock.lastCall![0],
    /** The card again with these rows, and this offer (the one it had unless given). */
    again: (rows: Priority[], o: MorningOffer | null = offer) => view.rerender(card(rows, o)),
  };
}

/** Today's card on the day store and the board store, wired as the sheet wires it. */
function OnTheStore({ pick = null }: { pick?: CategoryPick | null }) {
  const { day, store } = useDay(TODAY);
  const boardStore = useBoardStore();
  return day ? (
    <Priorities
      priorities={day.priorities}
      sessions={day.sessions}
      now={T0}
      pick={pick}
      onChange={(p, base) => store.setPriorities(TODAY, p, base)}
      onDeleteTask={(uid) => boardStore.deleteItem(uid)}
      onNote={() => Promise.resolve(true)}
    />
  ) : null;
}

/**
 * Renders `OnTheStore` against a server that stores each save as the route does (merged with
 * `mergePriorities`, free rows left out) the moment it arrives, and answers it once `answer()` is
 * called.
 */
async function renderOnStore(rows: Priority[], pick: CategoryPick | null = null) {
  let onServer = rows;
  const gate = deferred<void>();
  vi.mocked(api.getDay).mockImplementation(() => Promise.resolve(answered(makeDay(TODAY, { priorities: onServer }))));
  vi.mocked(api.putPriorities).mockImplementation(async (_date, list, base) => {
    onServer = mergePriorities(onServer, base ?? onServer, list).filter((p) => p.uid != null);
    const priorities = onServer;
    await gate.promise;
    return answered({ priorities });
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
  vi.mocked(api.getSettings).mockResolvedValue(answered(makeSettings()));
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
    expect(onChange).toHaveBeenCalledExactlyOnceWith([{ ...report, done: true }, emptyRow(2), emptyRow(3)], [report, emptyRow(2), emptyRow(3)]);
    // The store's copy now shows the save, with a row from another device: the card takes it up.
    await settle();
    const stored = [...saved(), makePriority(4, 'From the phone', { uid: 'phone0000000' })];
    again(stored);
    fireEvent.change(textbox(2), { target: { value: 'Email' } });
    fireEvent.blur(textbox(2));
    expect(onChange.mock.lastCall![1]).toEqual(stored);
  });

  it('celebrates a tick from its box with the priority sound, and not an untick', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(answered(makeSettings({ sounds: { ...makeSettings().sounds, priorityDone: 'pop' } })));
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

  it('adds on N as Add priority does, typing no n, with the focus on Add priority when it asks first', async () => {
    const add = () => screen.getByRole('button', { name: 'Add priority' });
    await renderCard([makePriority(1, 'Report')]);
    expect(add().getAttribute('aria-keyshortcuts')).toBe('N');
    expect(pressKey('n')).toBe(false);
    expect(document.activeElement).toBe(textbox(2));
    // In the box an N is typing.
    expect(pressKey('n')).toBe(true);
    cleanup();

    const { onChange } = await renderCard([makePriority(1, 'Report'), makePriority(2, 'Invoices'), makePriority(3, 'Email')]);
    pressKey('N', { shiftKey: true });
    expect(document.activeElement).toBe(add());
    expect(PRIORITY_WARNINGS.fresh.some((w) => screen.getByRole('status').textContent!.includes(w))).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    cleanup();

    // A full list has no Add priority, and N does nothing.
    await renderCard(Array.from({ length: MAX_PRIORITIES }, (_, i) => makePriority(i + 1, `Row ${i + 1}`)));
    expect(pressKey('n')).toBe(true);
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
  });

  it('keeps a row it added while free, though the stored list comes back without it, until the server holds a task there', async () => {
    const written = [makePriority(1, 'Report'), makePriority(2, 'Invoices'), makePriority(3, 'Email')];
    const { again, saved } = await renderCard(written);
    fireEvent.click(screen.getByRole('button', { name: 'Add priority' }));
    fireEvent.click(screen.getByRole('button', { name: WARNING_ACTIONS.fresh.add }));
    await settle();
    // The server keeps no free row.
    again([...written]);
    expect(screen.getAllByRole('textbox')).toHaveLength(4);
    expect(document.activeElement).toBe(textbox(4));
    fireEvent.change(textbox(4), { target: { value: 'Call the bank' } });
    fireEvent.blur(textbox(4));
    await settle();
    const bank = saved()[3]!;
    expect(bank).toMatchObject({ position: 4, text: 'Call the bank' });
    again([...written, bank]);
    // Then another device takes it off.
    again([...written]);
    expect(screen.getAllByRole('textbox')).toHaveLength(3);
  });

  it('keeps focus on a remove button when a row before the last is removed', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(answered(makeSettings({ priorityCount: 1 })));
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
});

describe("Priorities: a row's category", () => {
  const TICKETS = makeCategory('cat000000001', 'Tickets');
  const ADMIN = makeCategory('cat000000002', 'Admin', { color: 'teal' });
  const chip = (n: number) => screen.queryByRole('button', { name: new RegExp(`^Category for priority ${n}:`) });
  const option = (name: string) => screen.getByRole('option', { name });
  /** The card with the board on: the chip's data over Tickets and Admin, unless given. */
  const withPick = (rows: Priority[], pick: CategoryPick = makePick([TICKETS, ADMIN])) => renderCard(rows, [], pick);

  it('puts a chip at the end of each row with text while the board is on, and none on an empty row', async () => {
    await withPick([makePriority(1, 'Report', { categoryUid: TICKETS.uid }), makePriority(2, 'Email')]);
    expect(chip(1)!.getAttribute('aria-label')).toBe('Category for priority 1: Tickets');
    expect(chip(2)!.getAttribute('aria-label')).toBe('Category for priority 2: none');
    expect(chip(3)).toBeNull();
    const rows = [...document.querySelectorAll('.priority-row')];
    // Tick, text, note, chip, then ×.
    expect([...rows[0]!.querySelectorAll('input, textarea, button')].map((el) => el.getAttribute('aria-label'))).toEqual([
      'Priority 1 done',
      'Priority 1',
      'Add a note to priority 1',
      'Category for priority 1: Tickets',
      'Remove priority 1',
    ]);
  });

  it("gives every row the chip's column while the board is on, an empty one with no chip included", async () => {
    const rows = [makePriority(1, 'A'), makePriority(2, 'B'), makePriority(3, 'C'), emptyRow(4)];
    await withPick(rows);
    const shown = [...document.querySelectorAll('.priority-row')];
    expect(shown.map((r) => r.classList.contains('priority-row--chip'))).toEqual([true, true, true, true]);
    // The empty row past the usual count: the column, its ×, and no chip.
    expect(chip(4)).toBeNull();
    expect(shown[3]!.querySelector('.priority-end')).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove priority 4' })).toBeTruthy();
  });

  it("shows no chip and no chip column with the board off, and a written row's end holds its note button alone", async () => {
    await renderCard([makePriority(1, 'Report', { categoryUid: TICKETS.uid }), emptyRow(2), emptyRow(3), emptyRow(4)]);
    expect(chip(1)).toBeNull();
    expect(document.querySelectorAll('.priority-row')).toHaveLength(4);
    expect(document.querySelector('.priority-row--chip')).toBeNull();
    const ends = [...document.querySelectorAll('.priority-end')];
    expect(ends.map((end) => [...end.children].map((el) => el.getAttribute('aria-label')))).toEqual([['Add a note to priority 1']]);
  });

  it('puts the chip before the × on a row past the usual count', async () => {
    const rows = [makePriority(1, 'A'), makePriority(2, 'B'), makePriority(3, 'C'), makePriority(4, 'D')];
    await withPick(rows);
    const row = document.querySelectorAll('.priority-row')[3]!;
    expect(row.className).toContain('priority-row--chip');
    expect([...row.querySelectorAll('textarea, button')].map((el) => el.getAttribute('aria-label'))).toEqual([
      'Priority 4',
      'Add a note to priority 4',
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
    const [, list, base] = vi.mocked(api.putPriorities).mock.lastCall!;
    expect(list[0]).toMatchObject({ uid: report.uid, categoryUid: TICKETS.uid });
    expect(base?.[0]).toMatchObject({ uid: report.uid, categoryUid: null });
    await answer();
    expect(stored()[0]).toMatchObject({ uid: report.uid, categoryUid: TICKETS.uid });
    expect(chip(1)!.getAttribute('aria-label')).toBe('Category for priority 1: Tickets');
  });

  it('hides the chip while the box is blank, and shows the category again with the name', async () => {
    await withPick([makePriority(1, 'Report', { categoryUid: TICKETS.uid })]);
    act(() => textbox(1).focus());
    fireEvent.change(textbox(1), { target: { value: '' } });
    expect(chip(1)).toBeNull();
    fireEvent.blur(textbox(1));
    expect(chip(1)!.getAttribute('aria-label')).toBe('Category for priority 1: Tickets');
  });
});

/** A row left open on the last plan: its own task, named by its text, in no category unless patched. */
const seed = (text: string, patch: Partial<PrioritySeed> = {}): PrioritySeed => ({ uid: `left:${text}`, text, categoryUid: null, ...patch });

const QUEUE = makeRecurring('rcur00000001', 'Monitor the queue', { categoryUid: 'cafe00000001' });
const FOLLOW_UPS = makeRecurring('rcur00000002', 'Follow-ups');
const STANDUP = makeRecurring('rcur00000003', 'Standup notes');
/** A row of today's list that is `item`. */
const routineRow = (position: number, item: Recurring, patch: Partial<Priority> = {}) =>
  makePriority(position, item.title, { uid: item.uid, recurring: true, categoryUid: item.categoryUid, ...patch });

describe('Priorities: the morning offer', () => {
  const offerOf = (patch: Partial<MorningOffer> = {}): MorningOffer => ({ leftovers: null, recurring: [], answer: vi.fn(), ...patch });
  /** The leftovers group as the sheet hands it down, from yesterday. */
  const left = (rows: PrioritySeed[]) => ({ from: 'yesterday', rows });
  const withOffer = (rows: Priority[], offer: MorningOffer) => renderCard(rows, [], null, offer);
  const box = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement;
  const ticks = (...names: string[]) => names.map((n) => box(n).checked);
  const over = () => document.querySelector('.today-offer [role="status"]')!.textContent;
  const perDay = (n: number) => vi.mocked(api.getSettings).mockResolvedValue(answered(makeSettings({ recurringPerDay: n })));
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

  it('ticks fewer routines for those already on the list', async () => {
    perDay(2);
    const onList = routineRow(1, makeRecurring('rcur00000009', 'Weekly report'));
    await withOffer([onList], offerOf({ leftovers: left([seed('Invoices'), seed('Email')]), recurring: [QUEUE, FOLLOW_UPS] }));
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
    expect(saved().map((p) => p.recurring)).toEqual([false, false, false, true, true, true]);
    expect(
      saved()
        .slice(3)
        .map((p) => p.uid),
    ).toEqual([QUEUE.uid, FOLLOW_UPS.uid, STANDUP.uid]);
  });

  it('counts the routines on the list toward the line', async () => {
    perDay(1);
    await withOffer([routineRow(1, STANDUP)], offerOf({ recurring: [QUEUE] }));
    expect(ticks('Monitor the queue')).toEqual([false]);
    expect(over()).toBe('');
    fireEvent.click(box('Monitor the queue'));
    expect(over()).toBe(TODAY_OFFER.over(1));
  });

  it("counts a routine's row toward the ticks and the line while its box is blank", async () => {
    perDay(1);
    await withOffer([routineRow(1, STANDUP)], offerOf({ recurring: [QUEUE, STANDUP] }));
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
    const { onChange, saved } = await withOffer([], offerOf({ leftovers: left(leftovers), recurring: [QUEUE, FOLLOW_UPS, STANDUP], answer }));
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
      [4, 'Monitor the queue', QUEUE.uid, true],
      [5, 'Follow-ups', FOLLOW_UPS.uid, true],
    ]);
    expect(saved()[3]).toMatchObject({ addedAt: T0, categoryUid: QUEUE.categoryUid });
    // Standup notes was shown and left unticked: answered all the same.
    expect(answer).toHaveBeenCalledExactlyOnceWith([QUEUE.uid, FOLLOW_UPS.uid, STANDUP.uid], true);
    expect(document.activeElement).toBe(textbox(1));
    // The leftovers go with the one-off written, and the routines added with their rows; the sheet
    // then hands down no Standup notes, answered (the Sheet tests).
    expect(shown()).toEqual(['Standup notes']);
  });

  it("answers nothing when Add's save fails, and shows the notice again", async () => {
    const answer = vi.fn();
    const { onChange, again } = await withOffer([], offerOf({ leftovers: left([seed('Invoices')]), recurring: [QUEUE], answer }));
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

  it('with the board off shows the leftovers alone, each a ticked box, and brings each over as its own task, in its category, added now', async () => {
    const answer = vi.fn();
    const seeds = [seed('Invoices', { listed: 1, logged: 600 }), seed('Call the bank', { categoryUid: 'cafe00000001' })];
    const { saved } = await withOffer([], offerOf({ leftovers: left(seeds), answer }));
    expect(screen.getByRole('group', { name: LEFT_OPEN.title('yesterday') })).toBeTruthy();
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
    const { saved } = await withOffer([routineRow(1, QUEUE)], offerOf({ leftovers: left([seed('Invoices')]) }));
    fireEvent.click(screen.getByRole('button', { name: LEFT_OPEN.add }));
    expect(saved().map((p) => p.text)).toEqual(['Monitor the queue', 'Invoices', '']);
    expect(document.activeElement).toBe(textbox(2));
  });

  it('puts the focus on a routine Add put after the padded rows, a row the card had not drawn yet', async () => {
    await withOffer([], offerOf({ recurring: [QUEUE] }));
    fireEvent.click(screen.getByRole('button', { name: LEFT_OPEN.add }));
    expect(document.activeElement).toBe(textbox(4));
  });

  it('with nothing ticked, adds no row, answers every item shown and puts the focus where a new priority goes', async () => {
    const answer = vi.fn();
    const { saved } = await withOffer([emptyRow(1), routineRow(2, makeRecurring('rcur00000009', 'Weekly report'))], offerOf({ recurring: [QUEUE], answer }));
    fireEvent.click(box('Monitor the queue'));
    fireEvent.click(screen.getByRole('button', { name: LEFT_OPEN.add }));
    expect(saved().map((p) => p.text)).toEqual(['', 'Weekly report', '']);
    await settle();
    expect(answer).toHaveBeenCalledExactlyOnceWith([QUEUE.uid], false);
    expect(document.activeElement).toBe(textbox(1));
  });

  it('answers every item shown with Not today, saving nothing, and puts the focus where a new priority goes', async () => {
    const answer = vi.fn();
    const leftovers = [seed('Invoices')];
    const { onChange } = await withOffer([routineRow(1, STANDUP)], offerOf({ leftovers: left(leftovers), recurring: [QUEUE, FOLLOW_UPS], answer }));
    fireEvent.click(box('Follow-ups'));
    fireEvent.click(screen.getByRole('button', { name: TODAY_OFFER.notToday }));
    expect(answer).toHaveBeenCalledExactlyOnceWith([QUEUE.uid, FOLLOW_UPS.uid], true);
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(textbox(2));
  });

  it('is Start fresh with only leftovers shown, and answers no routine', async () => {
    const answer = vi.fn();
    // Every row is a routine's: no free row, so the focus goes to Add priority.
    const routines = [QUEUE, FOLLOW_UPS, STANDUP].map((item, i) => routineRow(i + 1, item));
    await withOffer(routines, offerOf({ leftovers: left([seed('Invoices')]), answer }));
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
    // The queue's row could still be removed today, and the notice offer it again.
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
    const rows = [routineRow(1, QUEUE), routineRow(2, FOLLOW_UPS, { done: true }), makePriority(3, 'Report'), emptyRow(4)];
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

  it('shows no mark with the board off', async () => {
    await renderCard([routineRow(1, QUEUE)]);
    expect(screen.queryByRole('img', { name: 'Repeats' })).toBeNull();
  });
});

describe('Priorities: a blank name', () => {
  const rows = () => [makePriority(1, 'Report'), makePriority(2, 'Email')];
  const hint = (name: string) => screen.queryByText(BLANK_HINT(name));
  const blankOut = (n: number) => {
    act(() => textbox(n).focus());
    fireEvent.change(textbox(n), { target: { value: '' } });
  };

  it("saves the name as it was, says so as the field's description, and brings the name back when the box is left", async () => {
    const { onChange } = await renderCard(rows());
    blankOut(1);
    expect(textbox(1).getAttribute('aria-describedby')).toBe(hint('Report')!.id);
    await settle(400);
    expect(textbox(1).value).toBe('');
    fireEvent.blur(textbox(1));
    expect(textbox(1).value).toBe('Report');
    expect(hint('Report')).toBeNull();
    expect(textbox(1).hasAttribute('aria-describedby')).toBe(false);
    expect(onChange).toHaveBeenCalled();
    for (const [list] of onChange.mock.calls) expect(list.map((p) => p.text)).toEqual(['Report', 'Email', '']);
  });

  it('brings the name back on Escape, with the focus kept in the box', async () => {
    await renderCard(rows());
    blankOut(2);
    fireEvent.keyDown(textbox(2), { key: 'Escape' });
    expect(textbox(2).value).toBe('Email');
    expect(document.activeElement).toBe(textbox(2));
    // Escape on a box with text leaves it be.
    fireEvent.change(textbox(2), { target: { value: 'Email Bob' } });
    fireEvent.keyDown(textbox(2), { key: 'Escape' });
    expect(textbox(2).value).toBe('Email Bob');
  });

  it("keeps the row's tick, with its box disabled, counted as a done row of the list, and saves no change to it", async () => {
    const { onChange } = await renderCard(rows());
    fireEvent.click(tick(1));
    blankOut(1);
    expect(tick(1).checked).toBe(true);
    expect(tick(1).disabled).toBe(true);
    expect(screen.getByText('1 of 2 done')).toBeTruthy();
    await settle(400);
    fireEvent.blur(textbox(1));
    expect(tick(1).checked).toBe(true);
    for (const [list] of onChange.mock.calls) expect([list[0]!.text, list[0]!.done]).toEqual(['Report', true]);
  });

  it("saves the other rows' changes with the name as it was, before and as the card goes away", async () => {
    const { onChange, unmount, saved } = await renderCard(rows());
    blankOut(1);
    fireEvent.click(tick(2));
    expect(saved().map((p) => [p.text, p.done])).toEqual([
      ['Report', false],
      ['Email', true],
      ['', false],
    ]);
    fireEvent.change(textbox(2), { target: { value: 'Email Bob' } });
    const sent = onChange.mock.calls.length;
    unmount();
    expect(onChange).toHaveBeenCalledTimes(sent + 1);
    expect(saved().map((p) => p.text)).toEqual(['Report', 'Email Bob', '']);
  });

  it('keeps the box empty while it has the focus, though the stored list changes under it', async () => {
    const { again } = await renderCard(rows());
    blankOut(1);
    fireEvent.click(tick(2));
    again([makePriority(1, 'Report'), makePriority(2, 'Email', { done: true })]);
    expect(textbox(1).value).toBe('');
    fireEvent.blur(textbox(1));
    expect(textbox(1).value).toBe('Report');
  });

  it('says so for a task typed in a free row, saved and then emptied in one stay in the box', async () => {
    const { saved, again } = await renderCard();
    act(() => textbox(1).focus());
    fireEvent.change(textbox(1), { target: { value: 'Call the bank' } });
    await settle(400);
    // The save's answer, with the task the first key made.
    again(saved());
    fireEvent.change(textbox(1), { target: { value: '' } });
    expect(textbox(1).getAttribute('aria-describedby')).toBe(hint('Call the bank')!.id);
  });

  it('makes a row typed and emptied before it was saved a free row again, with no hint and nothing sent', async () => {
    const { onChange } = await renderCard();
    act(() => textbox(1).focus());
    fireEvent.change(textbox(1), { target: { value: 'Call' } });
    fireEvent.change(textbox(1), { target: { value: '' } });
    expect(document.querySelector('.priority-hint')).toBeNull();
    fireEvent.blur(textbox(1));
    expect(onChange).toHaveBeenLastCalledWith([emptyRow(1), emptyRow(2), emptyRow(3)], [emptyRow(1), emptyRow(2), emptyRow(3)]);
    expect(screen.queryByRole('button', { name: 'Remove priority 1' })).toBeNull();
  });
});

describe('Priorities: the rename hint', () => {
  const hint = (n: number) => screen.queryByText(RENAME_HINT(n));

  it("shows while a name that earlier days' lists hold is retyped in the focused box, as its description", async () => {
    await renderCard([makePriority(1, 'Report', { earlier: 3 }), makePriority(2, 'Email')]);
    act(() => textbox(1).focus());
    expect(hint(3)).toBeNull();
    fireEvent.change(textbox(1), { target: { value: 'Report for Acme' } });
    expect(textbox(1).getAttribute('aria-describedby')).toBe(hint(3)!.id);
    // Typed back to the name it had: nothing renamed.
    fireEvent.change(textbox(1), { target: { value: 'Report' } });
    expect(hint(3)).toBeNull();
    fireEvent.change(textbox(1), { target: { value: 'Report for Acme' } });
    fireEvent.blur(textbox(1));
    expect(hint(3)).toBeNull();
  });

  it('says nothing for a task no earlier day holds', async () => {
    await renderCard([makePriority(1, 'Report', { listed: 2 })]);
    act(() => textbox(1).focus());
    fireEvent.change(textbox(1), { target: { value: 'Report for Acme' } });
    expect(document.querySelector('.priority-hint')).toBeNull();
  });
});

describe('Priorities: ×', () => {
  const x = (n: number) => screen.getByRole('button', { name: `Remove priority ${n}` });
  const dialog = () => screen.queryByRole('dialog');
  const offDay = () => fireEvent.click(screen.getByRole('button', { name: REMOVE_TASK.offDay }));
  const everywhere = () => fireEvent.click(screen.getByRole('button', { name: REMOVE_TASK.everywhere }));

  it('is on every row with a task, and on every row past Rows per day', async () => {
    await renderCard([makePriority(1, 'Report'), emptyRow(2), emptyRow(3), emptyRow(4)]);
    expect(screen.getAllByRole('button', { name: /^Remove priority/ }).map((b) => b.getAttribute('aria-label'))).toEqual([
      'Remove priority 1',
      'Remove priority 4',
    ]);
  });

  it('takes a task on no other day and with no time logged off at once, leaving a free row with the focus in it', async () => {
    const { saved, onDeleteTask } = await renderCard([makePriority(1, 'Report'), makePriority(2, 'Email'), makePriority(3, 'Invoices')]);
    fireEvent.click(x(2));
    expect(dialog()).toBeNull();
    expect(saved().map((p) => [p.text, p.uid])).toEqual([
      ['Report', rowUid(1)],
      ['', null],
      ['Invoices', rowUid(3)],
    ]);
    expect(document.activeElement).toBe(textbox(2));
    expect(onDeleteTask).not.toHaveBeenCalled();
  });

  it('counts a note of spaces and line breaks alone as none: its button is empty and × asks nothing', async () => {
    const { saved } = await renderCard([makePriority(1, 'Report', { note: ' \n\n' })]);
    expect(screen.getByRole('button', { name: 'Add a note to priority 1' }).classList.contains('note-toggle--empty')).toBe(true);
    fireEvent.click(x(1));
    expect(dialog()).toBeNull();
    expect(saved()[0]).toEqual(emptyRow(1));
  });

  it("never asks on a recurring priority's row", async () => {
    const { saved } = await renderCard([routineRow(1, QUEUE, { listed: 5, logged: 3000, note: 'Tier 2 too.' })]);
    fireEvent.click(x(1));
    expect(dialog()).toBeNull();
    expect(saved()[0]).toEqual(emptyRow(1));
  });

  it("asks about a task on other days, with time logged on it, the day's own sessions added to the other days', a timer running on it included, or with a note", async () => {
    const email = makePriority(1, 'Email');
    const cases: [Priority, Session[], string][] = [
      [makePriority(1, 'Email', { listed: 3 }), [], REMOVE_TASK.body(2, null, false)],
      [makePriority(1, 'Email', { logged: 80 * 60 }), [], REMOVE_TASK.body(0, '1h 20m', false)],
      [email, [completedSession(1, T0, 30, { priorityUid: email.uid })], REMOVE_TASK.body(0, '1m', false)],
      [email, [makeSession({ startedAt: T0 - 12 * MINUTE_MS, priorityUid: email.uid })], REMOVE_TASK.body(0, '12m', false)],
      [
        makePriority(1, 'Email', { logged: 60 * 60 }),
        [makeSession({ startedAt: T0 - 12 * MINUTE_MS, priorityUid: email.uid })],
        REMOVE_TASK.body(0, '1h 12m', false),
      ],
      // On no other day, with no time logged: the note alone asks, since it goes with the task.
      [makePriority(1, 'Email', { note: 'Ask Kim' }), [], REMOVE_TASK.body(0, null, true)],
      [makePriority(1, 'Email', { listed: 2, note: 'Ask Kim' }), [], REMOVE_TASK.body(1, null, true)],
    ];
    for (const [row, sessions, body] of cases) {
      const { onChange, unmount } = await renderCard([row], sessions);
      fireEvent.click(x(1));
      expect(dialog()!.textContent).toContain(REMOVE_TASK.title('Email'));
      // The facts are read with the title.
      expect(document.getElementById(dialog()!.getAttribute('aria-describedby')!)!.textContent).toBe(body);
      expect(onChange).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("counts a running timer to the sheet's minute, as the board's Delete does, not the second of the press", async () => {
    const email = makePriority(1, 'Email');
    await renderCard([email], [makeSession({ startedAt: T0 - 12 * MINUTE_MS, priorityUid: email.uid })]);
    vi.setSystemTime(T0 + 50_000);
    fireEvent.click(x(1));
    expect(document.getElementById(dialog()!.getAttribute('aria-describedby')!)!.textContent).toBe(REMOVE_TASK.body(0, '12m', false));
  });

  it('changes nothing on Cancel, and gives the focus back to the ×', async () => {
    const { onChange, onDeleteTask } = await renderCard([makePriority(1, 'Email', { listed: 2 })]);
    act(() => x(1).focus());
    fireEvent.click(x(1));
    fireEvent.click(screen.getByRole('button', { name: REMOVE_TASK.cancel }));
    expect(dialog()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(onDeleteTask).not.toHaveBeenCalled();
  });

  it('takes the task off this day only with Off this day', async () => {
    const { saved, onDeleteTask } = await renderCard([makePriority(1, 'Report'), makePriority(2, 'Email', { listed: 2 })]);
    fireEvent.click(x(2));
    offDay();
    expect(dialog()).toBeNull();
    expect(saved()[1]).toEqual(emptyRow(2));
    expect(document.activeElement).toBe(textbox(2));
    expect(onDeleteTask).not.toHaveBeenCalled();
  });

  it('removes a row past Rows per day with Off this day', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(answered(makeSettings({ priorityCount: 1 })));
    const { saved } = await renderCard([makePriority(1, 'Report'), makePriority(2, 'Email', { listed: 2 })]);
    fireEvent.click(x(2));
    offDay();
    expect(saved().map((p) => p.text)).toEqual(['Report']);
  });

  it('takes the task off this day, then deletes it everywhere, with Delete everywhere', async () => {
    const { onChange, saved, onDeleteTask } = await renderCard([makePriority(1, 'Email', { logged: 600 })]);
    onDeleteTask.mockImplementation(() => {
      expect(onChange).toHaveBeenCalledTimes(1);
      return Promise.resolve();
    });
    fireEvent.click(x(1));
    everywhere();
    expect(saved()[0]).toEqual(emptyRow(1));
    expect(onDeleteTask).toHaveBeenCalledExactlyOnceWith(rowUid(1));
    await settle();
    expect(warnSaveFailed).not.toHaveBeenCalled();
  });

  it('raises the banner when the delete fails, and leaves the task off this day', async () => {
    const { saved, onDeleteTask } = await renderCard([makePriority(1, 'Email', { listed: 2 })]);
    onDeleteTask.mockRejectedValue(new Error('Request failed (500)'));
    fireEvent.click(x(1));
    everywhere();
    await settle();
    expect(warnSaveFailed).toHaveBeenCalledOnce();
    expect(saved()[0]).toEqual(emptyRow(1));
  });

  it('still deletes everywhere when another device took the task off this list while it asked', async () => {
    const email = makePriority(1, 'Email', { listed: 2 });
    const { again, onChange, onDeleteTask } = await renderCard([email]);
    fireEvent.click(x(1));
    again([]);
    everywhere();
    expect(dialog()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(onDeleteTask).toHaveBeenCalledExactlyOnceWith(email.uid);
  });
});

describe('Priorities on the day store', () => {
  it('keeps a row Add priority put past Rows per day, with the focus in it, once the server answers without it, and saves it once typed in', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(answered(makeSettings({ priorityCount: 1 })));
    const { stored, answer } = await renderOnStore([makePriority(1, 'Report')]);
    fireEvent.click(screen.getByRole('button', { name: 'Add priority' }));
    expect(document.activeElement).toBe(textbox(2));
    await answer();
    expect(screen.getAllByRole('textbox')).toHaveLength(2);
    expect(document.activeElement).toBe(textbox(2));
    fireEvent.change(textbox(2), { target: { value: 'Call the bank' } });
    fireEvent.blur(textbox(2));
    await settle();
    expect(stored().map((p) => p.text)).toEqual(['Report', 'Call the bank']);
  });

  it('keeps the row Add anyway put past Rows per day the same, and lets its × take it away', async () => {
    const { stored, answer } = await renderOnStore([makePriority(1, 'Report'), makePriority(2, 'Invoices'), makePriority(3, 'Email')]);
    fireEvent.click(screen.getByRole('button', { name: 'Add priority' }));
    fireEvent.click(screen.getByRole('button', { name: WARNING_ACTIONS.fresh.add }));
    await answer();
    expect(screen.getAllByRole('textbox')).toHaveLength(4);
    expect(document.activeElement).toBe(textbox(4));
    fireEvent.change(textbox(4), { target: { value: 'Call the bank' } });
    fireEvent.blur(textbox(4));
    await settle();
    expect(stored().map((p) => p.text)).toEqual(['Report', 'Invoices', 'Email', 'Call the bank']);

    fireEvent.click(screen.getByRole('button', { name: 'Add priority' }));
    fireEvent.click(screen.getByRole('button', { name: WARNING_ACTIONS.fresh.add }));
    await settle();
    expect(screen.getAllByRole('textbox')).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'Remove priority 5' }));
    await settle();
    expect(screen.getAllByRole('textbox')).toHaveLength(4);
  });

  it('sends an untick made before the tick is answered as a change from the tick', async () => {
    const { stored, answer } = await renderOnStore([makePriority(1, 'Report')]);
    fireEvent.click(tick(1));
    await settle();
    fireEvent.click(tick(1));
    await answer();
    const sent = vi.mocked(api.putPriorities).mock.calls.map(([, list, base]) => [list[0]!.done, base![0]!.done]);
    expect(sent).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(stored()[0]!.done).toBe(false);
    expect(tick(1).checked).toBe(false);
  });

  it('keeps a row removed when its text was saved on the way out of it and not answered yet', async () => {
    const rows = [makePriority(1, 'Report'), makePriority(2, 'Invoices'), makePriority(3, 'Email'), emptyRow(4)];
    const { stored, answer } = await renderOnStore(rows);
    fireEvent.change(textbox(4), { target: { value: 'Call the bank' } });
    fireEvent.blur(textbox(4));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Remove priority 4' }));
    await answer();
    expect(stored().map((p) => p.text)).toEqual(['Report', 'Invoices', 'Email']);
    expect(screen.queryByLabelText('Priority 4')).toBeNull();
  });

  it('sends the list without the row, then deletes the task everywhere, with Delete everywhere', async () => {
    vi.mocked(api.deleteItem).mockResolvedValue(answered(makeBoard()));
    const { stored, answer } = await renderOnStore([makePriority(1, 'Report'), makePriority(2, 'Email', { listed: 3 })]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove priority 2' }));
    fireEvent.click(screen.getByRole('button', { name: REMOVE_TASK.everywhere }));
    await settle();
    // The delete waits for today's save without the row.
    expect(api.deleteItem).not.toHaveBeenCalled();
    await answer();
    expect(stored().map((p) => p.text)).toEqual(['Report']);
    expect(api.deleteItem).toHaveBeenCalledExactlyOnceWith(rowUid(2));
    expect(vi.mocked(api.putPriorities).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.deleteItem).mock.invocationCallOrder[0]!);
  });
});

describe("Priorities: a row's note", () => {
  const button = (n: number) => screen.getByRole('button', { name: new RegExp(`(^Note for|^Add a note to) priority ${n}$`) });
  const box = (n: number) => screen.queryByRole('textbox', { name: `Note for priority ${n}` }) as HTMLTextAreaElement | null;
  const open = (n: number) => fireEvent.click(button(n));
  const rows = () => [makePriority(1, 'Report', { note: 'Kim has the numbers.\nDue Friday.' }), makePriority(2, 'Email')];

  it('marks the button of a row with a note, and offers one on each written row, closed until it is pressed', async () => {
    await renderCard([...rows(), emptyRow(3)]);
    expect([button(1).getAttribute('aria-label'), button(1).classList.contains('note-toggle--empty')]).toEqual(['Note for priority 1', false]);
    expect([button(2).getAttribute('aria-label'), button(2).classList.contains('note-toggle--empty')]).toEqual(['Add a note to priority 2', true]);
    expect(screen.queryByRole('button', { name: /priority 3$/ })).toBeNull();
    expect(button(1).getAttribute('aria-expanded')).toBe('false');
    expect(box(1)).toBeNull();
  });

  it('opens the box with the focus in it, and Escape closes it with the text kept and the focus back on its button', async () => {
    await renderCard(rows());
    open(1);
    expect(button(1).getAttribute('aria-expanded')).toBe('true');
    expect(button(1).getAttribute('aria-controls')).toBe(box(1)!.id);
    expect(document.activeElement).toBe(box(1));
    expect(box(1)!.value).toBe('Kim has the numbers.\nDue Friday.');
    fireEvent.change(box(1)!, { target: { value: 'Kim has the numbers.' } });
    fireEvent.keyDown(box(1)!, { key: 'Escape' });
    expect(box(1)).toBeNull();
    expect(document.activeElement).toBe(button(1));
    open(1);
    expect(box(1)!.value).toBe('Kim has the numbers.');
  });

  it('saves a note 400 ms after the last key as the server stores it, and at once when the box is left, apart from the list', async () => {
    const { onChange, onNote } = await renderCard(rows());
    open(2);
    fireEvent.change(box(2)!, { target: { value: 'Ask\u0007 Sam\n' } });
    await settle(399);
    expect(onNote).not.toHaveBeenCalled();
    await settle(1);
    expect(onNote.mock.calls).toEqual([[rowUid(2), 'Ask Sam\n']]);
    fireEvent.change(box(2)!, { target: { value: 'Ask Sam first' } });
    fireEvent.blur(box(2)!);
    await settle();
    expect(onNote.mock.lastCall).toEqual([rowUid(2), 'Ask Sam first']);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps a note whose save failed in its box, closed or not, and sends it again on the next edit or when the box is left', async () => {
    const { onNote } = await renderCard(rows());
    onNote.mockResolvedValue(false);
    open(2);
    fireEvent.change(box(2)!, { target: { value: 'Ask Sam' } });
    fireEvent.keyDown(box(2)!, { key: 'Escape' });
    await settle();
    expect(onNote).toHaveBeenCalledTimes(1);
    open(2);
    expect(box(2)!.value).toBe('Ask Sam');
    fireEvent.blur(box(2)!);
    await settle();
    expect(onNote).toHaveBeenCalledTimes(2);
    onNote.mockResolvedValue(true);
    fireEvent.change(box(2)!, { target: { value: 'Ask Sam today' } });
    await settle(400);
    expect(onNote.mock.lastCall).toEqual([rowUid(2), 'Ask Sam today']);
  });

  it('takes up a note saved elsewhere while nothing is being typed, and hides the box while the name is blank', async () => {
    const { again } = await renderCard(rows());
    open(1);
    again([makePriority(1, 'Report', { note: 'From Kim' }), makePriority(2, 'Email')]);
    expect(box(1)!.value).toBe('From Kim');
    act(() => textbox(1).focus());
    fireEvent.change(textbox(1), { target: { value: '' } });
    expect(box(1)).toBeNull();
  });
});
