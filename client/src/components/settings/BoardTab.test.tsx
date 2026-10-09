// @vitest-environment happy-dom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { MINUTE_MS } from '../../../../shared/dates.js';
import * as api from '../../api';
import { BOARD_LIMITS, LIMITS } from '../../../../shared/api.js';
import { warnSaveFailed } from '../../lib/alerts';
import { withCategory, withCategoryPatch, withoutCategory, withItem, withItemPatch, withoutItem } from '../../lib/board';
import { BOARD, CONFIRM, LOAD_FAILED } from '../../lib/copy';
import { apiError, makeBoard, makeCategory, makeRecurring, makeSettings, settle, SettingsAndDays } from '../../test/hooks';
import type { Board } from '../../types';
import { BoardTab } from './BoardTab';

vi.mock('../../api');
vi.mock('../../lib/alerts');

const TICKETS = makeCategory('cat000000001', 'Tickets');
const ADMIN = makeCategory('cat000000002', 'Admin', { color: 'teal' });
const OLD = makeCategory('cat000000003', 'Old work', { color: 'gold', archived: true });
const QUEUE = makeRecurring('rec000000001', 'Monitor the queue', { categoryUid: TICKETS.uid });
const FOLLOW = makeRecurring('rec000000002', 'Follow-ups', { weekdays: [1, 3, 5] });

let onServer: Board;
/** Saves the dialog's header would call Not saved. */
let notSaved: number;
/** The dialog's save, as useSaveStatus runs it: the write, its failure caught and counted. */
const save = vi.fn((run: () => Promise<void>) =>
  run().catch(() => {
    notSaved++;
  }),
);
/** The dialog's settings setter. */
const set = vi.fn();

async function renderTab(settings = makeSettings({ board: true })) {
  render(
    <SettingsAndDays>
      <BoardTab settings={settings} set={set} save={save} />
    </SettingsAndDays>,
  );
  await settle();
}

const names = () => screen.queryAllByRole('textbox', { name: /^Name of / }).map((b) => (b as HTMLInputElement).value);
const nameBox = (name: string) => screen.getByRole('textbox', { name: `Name of ${name}` }) as HTMLInputElement;
const newBox = () => screen.getByRole('textbox', { name: 'New category' }) as HTMLInputElement;
const swatch = (category: string, colour: string) =>
  within(screen.getByRole('radiogroup', { name: `Colour of ${category}` })).getByRole('radio', { name: colour }) as HTMLInputElement;

beforeEach(() => {
  vi.useFakeTimers();
  notSaved = 0;
  onServer = { ...makeBoard(), categories: [TICKETS, ADMIN, OLD] };
  vi.mocked(api.getSettings).mockResolvedValue(makeSettings({ board: true }));
  vi.mocked(api.getBoard).mockImplementation(() => Promise.resolve(onServer));
  vi.mocked(api.addCategory).mockImplementation((c) => Promise.resolve((onServer = withCategory(onServer, c))));
  vi.mocked(api.patchCategory).mockImplementation((uid, patch) => Promise.resolve((onServer = withCategoryPatch(onServer, uid, patch))));
  vi.mocked(api.deleteCategory).mockImplementation((uid) => Promise.resolve((onServer = withoutCategory(onServer, uid))));
  vi.mocked(api.addItem).mockImplementation((item) => Promise.resolve((onServer = withItem(onServer, item, 0))));
  vi.mocked(api.editItem).mockImplementation((uid, patch) => Promise.resolve((onServer = withItemPatch(onServer, uid, patch))));
  vi.mocked(api.deleteItem).mockImplementation((uid) => Promise.resolve((onServer = withoutItem(onServer, uid))));
});

describe('BoardTab', () => {
  it('lists the categories in use, each with its name, its colour picked among eight, and Remove', async () => {
    await renderTab();
    expect(names()).toEqual(['Tickets', 'Admin']);
    const colours = within(screen.getByRole('radiogroup', { name: 'Colour of Tickets' })).getAllByRole('radio') as HTMLInputElement[];
    expect(colours.map((r) => r.getAttribute('aria-label'))).toEqual(['Blue', 'Teal', 'Green', 'Gold', 'Orange', 'Pink', 'Purple', 'Grey']);
    expect(colours.filter((r) => r.checked).map((r) => r.getAttribute('aria-label'))).toEqual(['Blue']);
    expect(swatch('Admin', 'Teal').checked).toBe(true);
    expect(screen.getByRole('button', { name: 'Remove Tickets' })).toBeTruthy();
    expect(screen.getByText('Removing a category keeps it on past days.')).toBeTruthy();
  });

  it('renames on blur or Enter, tidied, and puts back a blank or unchanged name, sending nothing', async () => {
    await renderTab();
    fireEvent.change(nameBox('Tickets'), { target: { value: '  Support   tickets ' } });
    fireEvent.blur(nameBox('Tickets'));
    await settle();
    expect(api.patchCategory).toHaveBeenCalledExactlyOnceWith(TICKETS.uid, { name: 'Support tickets' });
    expect(save).toHaveBeenCalledTimes(1);
    expect(names()).toEqual(['Support tickets', 'Admin']);

    nameBox('Admin').focus();
    fireEvent.change(nameBox('Admin'), { target: { value: 'Paperwork' } });
    // An input method's Enter picks its candidate and leaves the box alone.
    fireEvent.keyDown(nameBox('Admin'), { key: 'Enter', isComposing: true });
    expect(document.activeElement).toBe(nameBox('Admin'));
    fireEvent.keyDown(nameBox('Admin'), { key: 'Enter' });
    await settle();
    expect(api.patchCategory).toHaveBeenCalledTimes(2);
    expect(api.patchCategory).toHaveBeenLastCalledWith(ADMIN.uid, { name: 'Paperwork' });
    expect(document.activeElement).not.toBe(nameBox('Paperwork'));

    fireEvent.change(nameBox('Paperwork'), { target: { value: '   ' } });
    fireEvent.blur(nameBox('Paperwork'));
    fireEvent.change(nameBox('Paperwork'), { target: { value: 'Paperwork ' } });
    fireEvent.blur(nameBox('Paperwork'));
    await settle();
    expect(names()).toEqual(['Support tickets', 'Paperwork']);
    expect(api.patchCategory).toHaveBeenCalledTimes(2);
  });

  it('refuses a name another category in use has, whatever its case, and sends nothing', async () => {
    await renderTab();
    fireEvent.change(nameBox('Admin'), { target: { value: ' TICKETS' } });
    fireEvent.blur(nameBox('Admin'));
    await settle();
    expect(screen.getByRole('alert').textContent).toBe(BOARD.nameTaken);
    expect(nameBox('Admin').value).toBe(' TICKETS');
    // Enter on it keeps the focus in the box, to be fixed there.
    nameBox('Admin').focus();
    fireEvent.change(nameBox('Admin'), { target: { value: 'tickets' } });
    fireEvent.keyDown(nameBox('Admin'), { key: 'Enter' });
    expect(document.activeElement).toBe(nameBox('Admin'));
    expect(screen.getByRole('alert').textContent).toBe(BOARD.nameTaken);
    expect(api.patchCategory).not.toHaveBeenCalled();
    // A removed category's name is free.
    fireEvent.change(nameBox('Admin'), { target: { value: 'Old work' } });
    fireEvent.blur(nameBox('Admin'));
    await settle();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(api.patchCategory).toHaveBeenCalledExactlyOnceWith(ADMIN.uid, { name: 'Old work' });
  });

  it('recolours from a swatch, each one picked saved', async () => {
    await renderTab();
    fireEvent.click(swatch('Tickets', 'Pink'));
    await settle();
    expect(api.patchCategory).toHaveBeenCalledExactlyOnceWith(TICKETS.uid, { color: 'pink' });
    expect(swatch('Tickets', 'Pink').checked).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('removes a category with no confirm', async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Tickets' }));
    await settle();
    expect(api.deleteCategory).toHaveBeenCalledExactlyOnceWith(TICKETS.uid);
    expect(names()).toEqual(['Admin']);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('puts the focus on the next name a Remove leaves, else the one before, else Add category', async () => {
    await renderTab();
    const remove = (name: string) => {
      const button = screen.getByRole('button', { name: `Remove ${name}` });
      button.focus();
      fireEvent.click(button);
    };
    remove('Tickets');
    await settle();
    expect(document.activeElement).toBe(nameBox('Admin'));
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }));
    fireEvent.change(newBox(), { target: { value: 'Calls' } });
    fireEvent.keyDown(newBox(), { key: 'Enter' });
    fireEvent.blur(newBox());
    await settle();
    remove('Calls');
    await settle();
    expect(document.activeElement).toBe(nameBox('Admin'));
    remove('Admin');
    await settle();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add category' }));
  });

  it('adds categories from Add category, in the next colour, until the row is left blank', async () => {
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }));
    expect(document.activeElement).toBe(newBox());
    expect(newBox().parentElement!.querySelector('.cat-dot')?.getAttribute('data-color')).toBe('green');
    // Enter on a blank box does nothing.
    fireEvent.keyDown(newBox(), { key: 'Enter' });
    fireEvent.change(newBox(), { target: { value: 'Knowledge base' } });
    fireEvent.keyDown(newBox(), { key: 'Enter' });
    await settle();
    expect(api.addCategory).toHaveBeenCalledTimes(1);
    const [made] = vi.mocked(api.addCategory).mock.calls[0]!;
    expect(made).toMatchObject({ name: 'Knowledge base', color: 'green' });
    expect(made.uid).toMatch(/^[0-9a-f]{12}$/);
    expect(names()).toEqual(['Tickets', 'Admin', 'Knowledge base']);
    // The row stays for the next one, in the colour after.
    expect(newBox().value).toBe('');
    expect(newBox().parentElement!.querySelector('.cat-dot')?.getAttribute('data-color')).toBe('gold');
    fireEvent.change(newBox(), { target: { value: 'Calls' } });
    fireEvent.blur(newBox());
    await settle();
    expect(names()).toEqual(['Tickets', 'Admin', 'Knowledge base', 'Calls']);
    expect(screen.queryByRole('textbox', { name: 'New category' })).toBeNull();
    // Left blank, the row closes and sends nothing.
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }));
    fireEvent.blur(newBox());
    expect(screen.queryByRole('textbox', { name: 'New category' })).toBeNull();
    expect(api.addCategory).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('refuses a name in use, and brings a removed category back by its name', async () => {
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }));
    fireEvent.change(newBox(), { target: { value: 'admin' } });
    fireEvent.keyDown(newBox(), { key: 'Enter' });
    expect(screen.getByRole('alert').textContent).toBe(BOARD.nameTaken);
    fireEvent.blur(newBox());
    expect(newBox().value).toBe('admin');
    expect(api.addCategory).not.toHaveBeenCalled();

    fireEvent.change(newBox(), { target: { value: 'Old work' } });
    fireEvent.keyDown(newBox(), { key: 'Enter' });
    await settle();
    expect(api.addCategory).toHaveBeenCalledExactlyOnceWith({ uid: OLD.uid, name: 'Old work', color: 'gold' });
    expect(names()).toEqual(['Tickets', 'Admin', 'Old work']);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says when there are no categories yet', async () => {
    onServer = makeBoard();
    await renderTab();
    expect(screen.getByText('No categories yet.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }));
    expect(screen.queryByText('No categories yet.')).toBeNull();
  });

  it('reads the board as it opens, and offers Try again when it could not', async () => {
    vi.mocked(api.getBoard).mockRejectedValueOnce(new Error('offline'));
    await renderTab();
    expect(screen.getByText(new RegExp(LOAD_FAILED.board))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await settle();
    expect(names()).toEqual(['Tickets', 'Admin']);
  });
});

describe('BoardTab: recurring priorities', () => {
  const titles = () => screen.queryAllByRole('textbox', { name: /^Title of / }).map((b) => (b as HTMLInputElement).value);
  const titleBox = (title: string) => screen.getByRole('textbox', { name: `Title of ${title}` }) as HTMLInputElement;
  const newItemBox = () => screen.getByRole('textbox', { name: 'New recurring priority' }) as HTMLInputElement;
  const addButton = () => screen.getByRole('button', { name: 'Add recurring priority' });
  const days = (title: string) => within(screen.getByRole('group', { name: `Days for ${title}` })).getAllByRole('button');
  const day = (title: string, name: string) => within(screen.getByRole('group', { name: `Days for ${title}` })).getByRole('button', { name });
  const pressed = (title: string) =>
    days(title)
      .filter((b) => b.getAttribute('aria-pressed') === 'true')
      .map((b) => b.getAttribute('aria-label'));
  const removeButton = (title: string) => screen.getByRole('button', { name: `Remove recurring priority ${title}` });
  /** The delete's confirm, answered yes unless a case says otherwise. */
  let confirm: Mock<(message?: string) => boolean>;

  beforeEach(() => {
    onServer = { ...onServer, recurring: [QUEUE, FOLLOW] };
    confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
  });

  it('says how many recurring rows the morning offer ticks, described by its hint, and saves a change through set', async () => {
    await renderTab(makeSettings({ board: true, recurringPerDay: 4 }));
    expect(screen.getByText('Offered on Top priorities on these days. Nothing is added until you tap Add to today.')).toBeTruthy();
    const perDay = screen.getByRole('textbox', { name: 'Recurring rows per day' }) as HTMLInputElement;
    expect(perDay.value).toBe('4');
    expect(document.getElementById(perDay.getAttribute('aria-describedby')!)?.textContent).toBe('The morning offer ticks this many. You can tick more.');
    fireEvent.change(perDay, { target: { value: '12' } });
    fireEvent.blur(perDay);
    expect(set).toHaveBeenCalledExactlyOnceWith({ recurringPerDay: 10 });
  });

  it('lists them in the order they were made, each with its title, category, days and Remove', async () => {
    await renderTab();
    expect(titles()).toEqual(['Monitor the queue', 'Follow-ups']);
    expect(days('Monitor the queue').map((b) => [b.textContent, b.getAttribute('aria-label')])).toEqual([
      ['M', 'Monday'],
      ['T', 'Tuesday'],
      ['W', 'Wednesday'],
      ['T', 'Thursday'],
      ['F', 'Friday'],
      ['S', 'Saturday'],
      ['S', 'Sunday'],
    ]);
    expect(pressed('Monitor the queue')).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']);
    expect(pressed('Follow-ups')).toEqual(['Monday', 'Wednesday', 'Friday']);
    expect(screen.getByRole('button', { name: 'Category for Monitor the queue: Tickets' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Category for Follow-ups: none' })).toBeTruthy();
    expect(removeButton('Follow-ups').textContent).toBe('Remove');
    expect(titleBox('Follow-ups').maxLength).toBe(LIMITS.priorityText);
    expect(screen.queryByText('No recurring priorities yet.')).toBeNull();
  });

  it('renames on blur or Enter, trimmed, and puts back a blank or unchanged title, sending nothing', async () => {
    await renderTab();
    fireEvent.change(titleBox('Follow-ups'), { target: { value: '  Chase  replies ' } });
    fireEvent.blur(titleBox('Follow-ups'));
    await settle();
    expect(api.editItem).toHaveBeenCalledExactlyOnceWith(FOLLOW.uid, { title: 'Chase  replies' });
    expect(save).toHaveBeenCalledTimes(1);
    expect(titles()).toEqual(['Monitor the queue', 'Chase  replies']);

    titleBox('Monitor the queue').focus();
    fireEvent.change(titleBox('Monitor the queue'), { target: { value: 'Watch the queue' } });
    // An input method's Enter picks its candidate and leaves the box alone.
    fireEvent.keyDown(titleBox('Monitor the queue'), { key: 'Enter', isComposing: true });
    expect(document.activeElement).toBe(titleBox('Monitor the queue'));
    fireEvent.keyDown(titleBox('Monitor the queue'), { key: 'a' });
    expect(document.activeElement).toBe(titleBox('Monitor the queue'));
    fireEvent.keyDown(titleBox('Monitor the queue'), { key: 'Enter' });
    await settle();
    expect(api.editItem).toHaveBeenLastCalledWith(QUEUE.uid, { title: 'Watch the queue' });
    expect(document.activeElement).not.toBe(titleBox('Watch the queue'));

    fireEvent.change(titleBox('Watch the queue'), { target: { value: '   ' } });
    fireEvent.blur(titleBox('Watch the queue'));
    expect(titleBox('Watch the queue').value).toBe('Watch the queue');
    fireEvent.change(titleBox('Watch the queue'), { target: { value: ' Watch the queue ' } });
    fireEvent.blur(titleBox('Watch the queue'));
    expect(titleBox('Watch the queue').value).toBe('Watch the queue');
    await settle();
    expect(api.editItem).toHaveBeenCalledTimes(2);
  });

  it('shows a rename from another device in the box, and puts the title back when a rename is not saved', async () => {
    await renderTab();
    onServer = withItemPatch(onServer, FOLLOW.uid, { title: 'Chase replies' });
    await settle(MINUTE_MS);
    expect(titles()).toEqual(['Monitor the queue', 'Chase replies']);

    vi.mocked(api.editItem).mockRejectedValueOnce(new Error('offline'));
    fireEvent.change(titleBox('Chase replies'), { target: { value: 'Calls' } });
    fireEvent.blur(titleBox('Chase replies'));
    await settle();
    expect(notSaved).toBe(1);
    expect(titles()).toEqual(['Monitor the queue', 'Chase replies']);
  });

  it("sets a category from the row's chip", async () => {
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Category for Follow-ups: none' }));
    fireEvent.click(screen.getByRole('option', { name: 'Admin' }));
    await settle();
    expect(api.editItem).toHaveBeenCalledExactlyOnceWith(FOLLOW.uid, { categoryUid: ADMIN.uid });
    expect(screen.getByRole('button', { name: 'Category for Follow-ups: Admin' })).toBeTruthy();
    expect(save).toHaveBeenCalledTimes(1);
    // No category takes it off.
    fireEvent.click(screen.getByRole('button', { name: 'Category for Monitor the queue: Tickets' }));
    fireEvent.click(screen.getByRole('option', { name: 'No category' }));
    await settle();
    expect(api.editItem).toHaveBeenLastCalledWith(QUEUE.uid, { categoryUid: null });
    expect(screen.getByRole('button', { name: 'Category for Monitor the queue: none' })).toBeTruthy();
  });

  it('says Not saved in the header for a category the chip made that the server refused, not in a banner', async () => {
    await renderTab();
    vi.mocked(api.addCategory).mockRejectedValueOnce(new Error('Request failed (400)'));
    fireEvent.click(screen.getByRole('button', { name: 'Category for Follow-ups: none' }));
    const box = screen.getByRole('textbox', { name: 'New category' });
    fireEvent.change(box, { target: { value: 'Calls' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await settle();
    expect(api.addCategory).toHaveBeenCalledTimes(1);
    expect(notSaved).toBe(1);
    expect(warnSaveFailed).not.toHaveBeenCalled();
    // What picked it reads as no category once the board has it back off.
    expect(screen.getByRole('button', { name: 'Category for Follow-ups: none' })).toBeTruthy();
  });

  it('sends only the day pressed, and keeps the last day on', async () => {
    onServer = { ...onServer, recurring: [QUEUE, FOLLOW, makeRecurring('rec000000003', 'Timesheet', { weekdays: [5] })] };
    await renderTab();
    fireEvent.click(day('Follow-ups', 'Tuesday'));
    await settle();
    expect(api.editItem).toHaveBeenLastCalledWith(FOLLOW.uid, { weekday: { day: 2, on: true } });
    expect(pressed('Follow-ups')).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Friday']);
    fireEvent.click(day('Monitor the queue', 'Monday'));
    await settle();
    expect(api.editItem).toHaveBeenLastCalledWith(QUEUE.uid, { weekday: { day: 1, on: false } });
    expect(pressed('Monitor the queue')).toEqual(['Tuesday', 'Wednesday', 'Thursday', 'Friday']);

    // The one day left stays pressed and in reach, and a press on it sends nothing.
    const friday = day('Timesheet', 'Friday');
    expect(friday.getAttribute('aria-disabled')).toBe('true');
    expect((friday as HTMLButtonElement).disabled).toBe(false);
    expect(day('Timesheet', 'Monday').hasAttribute('aria-disabled')).toBe(false);
    expect(day('Follow-ups', 'Monday').hasAttribute('aria-disabled')).toBe(false);
    fireEvent.click(friday);
    await settle();
    expect(api.editItem).toHaveBeenCalledTimes(2);
    expect(pressed('Timesheet')).toEqual(['Friday']);
    // Another day on frees it.
    fireEvent.click(day('Timesheet', 'Sunday'));
    await settle();
    expect(api.editItem).toHaveBeenLastCalledWith('rec000000003', { weekday: { day: 7, on: true } });
    expect(day('Timesheet', 'Friday').hasAttribute('aria-disabled')).toBe(false);
  });

  it('removes one once confirmed, the focus on the next title, else the one before, else Add recurring priority', async () => {
    await renderTab();
    const remove = (title: string) => {
      const button = removeButton(title);
      button.focus();
      fireEvent.click(button);
    };
    remove('Monitor the queue');
    expect(confirm).toHaveBeenCalledExactlyOnceWith(CONFIRM.deleteRecurring('Monitor the queue'));
    await settle();
    expect(api.deleteItem).toHaveBeenCalledExactlyOnceWith(QUEUE.uid);
    expect(titles()).toEqual(['Follow-ups']);
    expect(document.activeElement).toBe(titleBox('Follow-ups'));
    fireEvent.click(addButton());
    fireEvent.change(newItemBox(), { target: { value: 'Timesheet' } });
    fireEvent.keyDown(newItemBox(), { key: 'Enter' });
    fireEvent.blur(newItemBox());
    await settle();
    remove('Timesheet');
    await settle();
    expect(document.activeElement).toBe(titleBox('Follow-ups'));
    remove('Follow-ups');
    await settle();
    expect(document.activeElement).toBe(addButton());
    expect(screen.getByText('No recurring priorities yet.')).toBeTruthy();
    expect(save).toHaveBeenCalledTimes(4);
  });

  it('sends nothing and leaves the focus on Remove when the confirm is turned down', async () => {
    confirm.mockReturnValue(false);
    await renderTab();
    const button = removeButton('Follow-ups');
    button.focus();
    fireEvent.click(button);
    expect(confirm).toHaveBeenCalledExactlyOnceWith(CONFIRM.deleteRecurring('Follow-ups'));
    await settle();
    expect(api.deleteItem).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(titles()).toEqual(['Monitor the queue', 'Follow-ups']);
    expect(document.activeElement).toBe(removeButton('Follow-ups'));

    confirm.mockReturnValue(true);
    fireEvent.click(removeButton('Follow-ups'));
    await settle();
    expect(api.deleteItem).toHaveBeenCalledExactlyOnceWith(FOLLOW.uid);
    expect(titles()).toEqual(['Monitor the queue']);
  });

  it("names its Remove apart from a category's of the same name, and each removes its own", async () => {
    onServer = { ...onServer, categories: [TICKETS, makeCategory('cat000000009', 'Follow-ups')], recurring: [FOLLOW] };
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Follow-ups' }));
    await settle();
    expect(api.deleteCategory).toHaveBeenCalledExactlyOnceWith('cat000000009');
    expect(api.deleteItem).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove recurring priority Follow-ups' }));
    await settle();
    expect(api.deleteItem).toHaveBeenCalledExactlyOnceWith(FOLLOW.uid);
    expect(api.deleteCategory).toHaveBeenCalledTimes(1);
  });

  it('puts the focus on the next title when a row in the middle goes', async () => {
    onServer = { ...onServer, recurring: [QUEUE, FOLLOW, makeRecurring('rec000000003', 'Timesheet')] };
    await renderTab();
    const button = removeButton('Follow-ups');
    button.focus();
    fireEvent.click(button);
    await settle();
    expect(titles()).toEqual(['Monitor the queue', 'Timesheet']);
    expect(document.activeElement).toBe(titleBox('Timesheet'));
  });

  it('names the row by its stored title while a rename is typed', async () => {
    await renderTab();
    fireEvent.change(titleBox('Follow-ups'), { target: { value: 'Chase replies' } });
    expect(screen.getByRole('group', { name: 'Days for Follow-ups' })).toBeTruthy();
    expect(removeButton('Follow-ups')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Category for Follow-ups: none' })).toBeTruthy();
  });

  it('counts a delete another device made already as done', async () => {
    await renderTab();
    vi.mocked(api.deleteItem).mockRejectedValueOnce(apiError(404));
    fireEvent.click(removeButton('Follow-ups'));
    await settle();
    expect(titles()).toEqual(['Monitor the queue']);
    expect(notSaved).toBe(0);
  });

  it('adds one from Add recurring priority on the work week, with a fresh uid, until the row is left blank', async () => {
    await renderTab();
    fireEvent.click(addButton());
    expect(document.activeElement).toBe(newItemBox());
    expect(newItemBox().placeholder).toBe('Recurring priority');
    // Enter on a blank box does nothing, nor does an input method's Enter.
    fireEvent.keyDown(newItemBox(), { key: 'Enter' });
    fireEvent.change(newItemBox(), { target: { value: '  Timesheet ' } });
    fireEvent.keyDown(newItemBox(), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(newItemBox(), { key: 'Tab' });
    await settle();
    expect(api.addItem).not.toHaveBeenCalled();
    expect(newItemBox().value).toBe('  Timesheet ');
    expect(newItemBox().maxLength).toBe(LIMITS.priorityText);
    fireEvent.keyDown(newItemBox(), { key: 'Enter' });
    await settle();
    expect(api.addItem).toHaveBeenCalledTimes(1);
    const [made] = vi.mocked(api.addItem).mock.calls[0]!;
    expect(made).toMatchObject({ title: 'Timesheet', categoryUid: null, weekdays: [1, 2, 3, 4, 5] });
    expect(made.uid).toMatch(/^[0-9a-f]{12}$/);
    expect(titles()).toEqual(['Monitor the queue', 'Follow-ups', 'Timesheet']);
    // The row stays for the next one.
    expect(newItemBox().value).toBe('');
    fireEvent.change(newItemBox(), { target: { value: 'Inbox zero' } });
    fireEvent.blur(newItemBox());
    await settle();
    expect(titles()).toEqual(['Monitor the queue', 'Follow-ups', 'Timesheet', 'Inbox zero']);
    expect(vi.mocked(api.addItem).mock.calls[1]![0].uid).not.toBe(made.uid);
    expect(screen.queryByRole('textbox', { name: 'New recurring priority' })).toBeNull();
    // Left blank, the row closes and sends nothing.
    fireEvent.click(addButton());
    fireEvent.blur(newItemBox());
    expect(screen.queryByRole('textbox', { name: 'New recurring priority' })).toBeNull();
    expect(api.addItem).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('offers Add recurring priority however many there are, the cap showing only as Not saved', async () => {
    onServer = {
      ...onServer,
      recurring: Array.from({ length: BOARD_LIMITS.recurring }, (_, i) => makeRecurring(`rec${String(i).padStart(9, '0')}`, `Item ${i}`)),
    };
    vi.mocked(api.addItem).mockRejectedValueOnce(new Error('Request failed (400)'));
    await renderTab();
    expect(titles()).toHaveLength(BOARD_LIMITS.recurring);
    fireEvent.click(addButton());
    fireEvent.change(newItemBox(), { target: { value: 'One more' } });
    fireEvent.keyDown(newItemBox(), { key: 'Enter' });
    await settle();
    expect(notSaved).toBe(1);
    expect(titles()).toHaveLength(BOARD_LIMITS.recurring);
  });

  it('says when there are none yet, until Add recurring priority opens its row', async () => {
    onServer = { ...onServer, recurring: [] };
    await renderTab();
    expect(screen.getByText('No recurring priorities yet.')).toBeTruthy();
    fireEvent.click(addButton());
    expect(screen.queryByText('No recurring priorities yet.')).toBeNull();
  });

  it('shows no chip once the board is off, as the dialog takes the tab away', async () => {
    await renderTab();
    vi.mocked(api.getSettings).mockResolvedValue(makeSettings());
    await settle(MINUTE_MS);
    expect(titles()).toEqual(['Monitor the queue', 'Follow-ups']);
    expect(screen.queryByRole('button', { name: /^Category for / })).toBeNull();
  });
});
