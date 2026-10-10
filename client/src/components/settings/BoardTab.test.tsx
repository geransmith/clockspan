// @vitest-environment happy-dom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../api';
import { withCategory, withCategoryPatch, withoutCategory } from '../../lib/board';
import { BOARD, LOAD_FAILED } from '../../lib/copy';
import { answered, makeBoard, makeCategory, makeSettings, settle, SettingsAndDays } from '../../test/hooks';
import type { Board } from '../../types';
import { BoardTab } from './BoardTab';

vi.mock('../../api');
vi.mock('../../lib/alerts');

const TICKETS = makeCategory('cat000000001', 'Tickets');
const ADMIN = makeCategory('cat000000002', 'Admin', { color: 'teal' });
const OLD = makeCategory('cat000000003', 'Old work', { color: 'gold', archived: true });

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

async function renderTab(settings = makeSettings()) {
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
  vi.mocked(api.getSettings).mockResolvedValue(answered(makeSettings()));
  vi.mocked(api.getBoard).mockImplementation(() => Promise.resolve(answered(onServer)));
  vi.mocked(api.addCategory).mockImplementation((c) => Promise.resolve(answered((onServer = withCategory(onServer, c)))));
  vi.mocked(api.patchCategory).mockImplementation((uid, patch) => Promise.resolve(answered((onServer = withCategoryPatch(onServer, uid, patch)))));
  vi.mocked(api.deleteCategory).mockImplementation((uid) => Promise.resolve(answered((onServer = withoutCategory(onServer, uid)))));
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

  it('refuses a name in use until the box is emptied, and brings a removed category back by its name', async () => {
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }));
    fireEvent.change(newBox(), { target: { value: 'admin' } });
    fireEvent.keyDown(newBox(), { key: 'Enter' });
    expect(screen.getByRole('alert').textContent).toBe(BOARD.nameTaken);
    expect(newBox().getAttribute('aria-invalid')).toBe('true');
    fireEvent.blur(newBox());
    expect(newBox().value).toBe('admin');
    expect(api.addCategory).not.toHaveBeenCalled();
    // Emptied, the box drops the line.
    fireEvent.change(newBox(), { target: { value: '' } });
    fireEvent.keyDown(newBox(), { key: 'Enter' });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(newBox().hasAttribute('aria-invalid')).toBe(false);

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

  it('says how many recurring rows the morning offer ticks, described by its hint, and saves a change through set', async () => {
    await renderTab(makeSettings({ recurringPerDay: 4 }));
    expect(
      screen.getByText('A card set to repeat on the board is offered on Top priorities on its days. Nothing is added until you tap Add to today.'),
    ).toBeTruthy();
    const perDay = screen.getByRole('textbox', { name: 'Recurring rows per day' }) as HTMLInputElement;
    expect(perDay.value).toBe('4');
    expect(document.getElementById(perDay.getAttribute('aria-describedby')!)?.textContent).toBe('The morning offer ticks this many. You can tick more.');
    fireEvent.change(perDay, { target: { value: '12' } });
    fireEvent.blur(perDay);
    expect(set).toHaveBeenCalledExactlyOnceWith({ recurringPerDay: 10 });
  });

  it('reads the board as it opens, and offers Try again when it could not', async () => {
    // The tab's read and the provider's, both as it mounts.
    vi.mocked(api.getBoard).mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'));
    await renderTab();
    expect(screen.getByText(new RegExp(LOAD_FAILED.board))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    await settle();
    expect(names()).toEqual(['Tickets', 'Admin']);
  });
});
