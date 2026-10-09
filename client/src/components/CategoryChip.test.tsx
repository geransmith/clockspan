// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useModalDialog } from '../hooks/useModalDialog';
import { makeCategory, makePick, NEW_CATEGORY } from '../test/fixtures';
import type { Category } from '../types';
import { CategoryChip } from './CategoryChip';

const TICKETS = makeCategory('cat000000001', 'Tickets');
const ADMIN = makeCategory('cat000000002', 'Admin', { color: 'teal' });
const KB = makeCategory('cat000000003', 'Knowledge base', { color: 'green' });
const CATS = [TICKETS, ADMIN, KB];
const LABEL = 'Category for new cards';

/** A modal dialog, as Settings is: Escape closes it. */
function InDialog({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const dialog = useModalDialog(onClose);
  return <dialog {...dialog}>{children}</dialog>;
}

/**
 * The chip with a button beside it, in a dialog whose `onClose` it gives back, and `reread`,
 * which renders it again over other categories, as a board read landing does.
 */
function renderChip(value: string | null = null, categories: Category[] = CATS, disabled = false) {
  const onChange = vi.fn();
  const onClose = vi.fn();
  const pick = makePick(categories);
  const ui = (cats: Category[]) => (
    <InDialog onClose={onClose}>
      <CategoryChip value={value} onChange={onChange} pick={{ ...pick, categories: cats }} label={LABEL} disabled={disabled} />
      <button>Outside</button>
    </InDialog>
  );
  const { rerender } = render(ui(categories));
  return { onChange, onClose, pick, reread: (cats: Category[]) => rerender(ui(cats)) };
}

// The dialog's content counts as hidden to the queries under happy-dom, as in SettingsDialog's tests.
const chip = () => screen.getByRole('button', { name: new RegExp(`^${LABEL}`), hidden: true });
const options = () => screen.getAllByRole('option', { hidden: true });
const listbox = () => screen.getByRole('listbox', { hidden: true });
const newBox = () => screen.getByRole('textbox', { name: 'New category', hidden: true });
const outside = () => screen.getByRole('button', { name: 'Outside', hidden: true });
const optionNames = () => options().map((o) => o.textContent);
const focusedName = () => document.activeElement?.textContent;
const isOpen = () => chip().getAttribute('aria-expanded') === 'true';
const key = (el: Element, k: string) => fireEvent.keyDown(el, { key: k });

describe('CategoryChip', () => {
  it('shows the category set with its name, or a dashed Category for none or a uid the board lacks', () => {
    renderChip(ADMIN.uid);
    expect(chip().textContent).toBe('Admin');
    expect(chip().getAttribute('aria-label')).toBe(`${LABEL}: Admin`);
    expect(chip().className).not.toContain('category-chip--empty');
    cleanup();
    renderChip('gone00000001');
    expect(chip().textContent).toBe('Category');
    expect(chip().getAttribute('aria-label')).toBe(`${LABEL}: none`);
    expect(chip().className).toContain('category-chip--empty');
  });

  it('opens on a press, reads the board again, and puts the focus on the selected option', () => {
    const { pick } = renderChip(ADMIN.uid);
    expect(screen.queryByRole('listbox', { hidden: true })).toBeNull();
    fireEvent.click(chip());
    expect(isOpen()).toBe(true);
    expect(chip().getAttribute('aria-controls')).toBe(screen.getByRole('listbox', { name: 'Category', hidden: true }).id);
    expect(pick.refresh).toHaveBeenCalledTimes(1);
    expect(optionNames()).toEqual(['No category', 'Tickets', 'Admin', 'Knowledge base']);
    expect(document.activeElement).toBe(options()[2]);
    expect(options().map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true', 'false']);
    // A second press closes it.
    fireEvent.click(chip());
    expect(isOpen()).toBe(false);
  });

  it("doesn't open while disabled, on a press or from the keyboard", () => {
    const { pick } = renderChip(ADMIN.uid, CATS, true);
    expect((chip() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(chip());
    // A disabled button takes no focus, so no key reaches it.
    chip().focus();
    expect(document.activeElement).not.toBe(chip());
    expect(isOpen()).toBe(false);
    expect(screen.queryByRole('listbox', { hidden: true })).toBeNull();
    expect(pick.refresh).not.toHaveBeenCalled();
  });

  it('leaves the focus where it is on a press, for the list to take as it opens and give back to the chip as it closes', () => {
    renderChip(ADMIN.uid);
    // false: the press's default, which moves the focus (to the page, in Safari), was stopped.
    expect(fireEvent.mouseDown(chip())).toBe(false);
    fireEvent.click(chip());
    expect(document.activeElement).toBe(options()[2]);
    expect(fireEvent.mouseDown(chip())).toBe(false);
    fireEvent.click(chip());
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(chip());
  });

  it('opens on ArrowDown with the focus on No category when none is set', () => {
    renderChip();
    expect(key(chip(), 'ArrowDown')).toBe(false);
    expect(isOpen()).toBe(true);
    expect(focusedName()).toBe('No category');
    key(document.activeElement!, 'ArrowDown');
    // Open, with the focus back on the chip (Shift+Tab), ArrowDown goes back to the option it left.
    chip().focus();
    expect(key(chip(), 'ArrowDown')).toBe(false);
    expect(isOpen()).toBe(true);
    expect(focusedName()).toBe('Tickets');
  });

  it('moves with the arrows without wrapping, and Home and End reach the first and last of 30', () => {
    const many = Array.from({ length: 30 }, (_, i) => makeCategory(`cat${String(i).padStart(9, '0')}`, `Category ${i + 1}`));
    renderChip(null, many);
    fireEvent.click(chip());
    expect(options()).toHaveLength(31);
    const focused = () => document.activeElement!;
    key(focused(), 'ArrowUp');
    expect(focusedName()).toBe('No category');
    key(focused(), 'ArrowDown');
    key(focused(), 'ArrowDown');
    expect(focusedName()).toBe('Category 2');
    key(focused(), 'End');
    expect(focusedName()).toBe('Category 30');
    key(focused(), 'ArrowDown');
    expect(focusedName()).toBe('Category 30');
    key(focused(), 'Home');
    expect(focusedName()).toBe('No category');
    // Other keys do nothing.
    key(focused(), 'a');
    expect(focusedName()).toBe('No category');
    // Roving focus: one option in the tab order at a time.
    expect(options().filter((o) => o.tabIndex === 0)).toEqual([document.activeElement]);
    // The New category box stays under the list however long it gets.
    expect(newBox()).toBeTruthy();
  });

  it('picks with Enter or Space, closes and gives the focus back to the chip', () => {
    const { onChange } = renderChip(TICKETS.uid);
    fireEvent.click(chip());
    key(document.activeElement!, 'ArrowDown');
    key(document.activeElement!, 'Enter');
    expect(onChange).toHaveBeenCalledExactlyOnceWith(ADMIN.uid);
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(chip());
    // Space on the one already set closes and changes nothing.
    fireEvent.click(chip());
    key(document.activeElement!, ' ');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(isOpen()).toBe(false);
  });

  it('picks with a click, No category included', () => {
    const { onChange } = renderChip(TICKETS.uid);
    fireEvent.click(chip());
    fireEvent.click(screen.getByRole('option', { name: 'No category', hidden: true }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(null);
    expect(document.activeElement).toBe(chip());
  });

  it('closes on Escape with no change, and the dialog around it stays open', () => {
    const { onChange, onClose } = renderChip(TICKETS.uid);
    // Each Escape's default is prevented too: a real modal dialog closes on it through its cancel
    // event, which stopping the key's propagation doesn't reach.
    fireEvent.click(chip());
    expect(key(document.activeElement!, 'Escape')).toBe(false);
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(chip());
    fireEvent.click(chip());
    expect(key(newBox(), 'Escape')).toBe(false);
    expect(isOpen()).toBe(false);
    // Open with the focus back on the chip, as after Shift+Tab out of the list.
    fireEvent.click(chip());
    expect(key(chip(), 'Escape')).toBe(false);
    expect(isOpen()).toBe(false);
    // An input method's Escape drops its candidate and leaves the list open.
    fireEvent.click(chip());
    fireEvent.keyDown(newBox(), { key: 'Escape', isComposing: true });
    expect(isOpen()).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // Closed, Escape is the dialog's again.
    key(document.activeElement!, 'Escape');
    key(chip(), 'Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays open while the focus moves between the list and the New category box, and closes when it leaves both', () => {
    renderChip(TICKETS.uid);
    fireEvent.click(chip());
    const box = newBox();
    // Tab goes from the focused option to the box, the next control in the page's order.
    const tabbable = [...document.querySelectorAll<HTMLElement>('button, [tabindex="0"], input')];
    expect(tabbable.slice(tabbable.indexOf(document.activeElement as HTMLElement) + 1)[0]).toBe(box);
    fireEvent.blur(document.activeElement!, { relatedTarget: box });
    expect(isOpen()).toBe(true);
    fireEvent.blur(box, { relatedTarget: chip() });
    expect(isOpen()).toBe(true);
    // Focus going nowhere (the window losing it) leaves it open.
    fireEvent.blur(box, { relatedTarget: null });
    expect(isOpen()).toBe(true);
    fireEvent.blur(chip(), { relatedTarget: outside() });
    expect(isOpen()).toBe(false);
  });

  it('leaves the focus where it is when a board read changes the list while it is open', () => {
    const { reread } = renderChip();
    fireEvent.click(chip());
    key(document.activeElement!, 'End');
    expect(focusedName()).toBe('Knowledge base');
    // Tabbed on to New category and typing, when a removal made on another device lands.
    newBox().focus();
    fireEvent.change(newBox(), { target: { value: 'Fol' } });
    reread([TICKETS, { ...ADMIN, archived: true }, KB]);
    expect(optionNames()).toEqual(['No category', 'Tickets', 'Knowledge base']);
    expect(document.activeElement).toBe(newBox());
    // The last option left takes its place in the tab order.
    expect(
      options()
        .filter((o) => o.tabIndex === 0)
        .map((o) => o.textContent),
    ).toEqual(['Knowledge base']);
  });

  it('closes on a press outside with no change, and stays open for a press inside', () => {
    const { onChange } = renderChip();
    fireEvent.click(chip());
    const focused = document.activeElement;
    fireEvent.pointerDown(listbox());
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(focused);
    const focus = vi.spyOn(chip(), 'focus');
    fireEvent.pointerDown(outside());
    expect(isOpen()).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    // The focus was on an option, which goes with the list: it is on the chip for the press's
    // mousedown to move on, never left to fall to the page. The list is fixed, so the chip can
    // be scrolled out of sight under it; scrolling it back would move the page under the press.
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(document.activeElement).toBe(chip());
  });

  it('leaves the focus where it is on a press outside while the list does not hold it', () => {
    renderChip();
    fireEvent.click(chip());
    // Shift+Tab out of the first option: the one way the list stays open without the focus.
    chip().focus();
    expect(isOpen()).toBe(true);
    const focus = vi.spyOn(chip(), 'focus');
    fireEvent.pointerDown(outside());
    expect(isOpen()).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(chip());
  });

  it('leaves the focus where it is on a press inside the list, but for the New category box', () => {
    renderChip();
    fireEvent.click(chip());
    const focused = document.activeElement;
    // false: the press's default, which would move the focus to the page from the list's padding
    // or the gap above the box, was stopped.
    expect(fireEvent.mouseDown(document.querySelector('.category-pop')!)).toBe(false);
    expect(fireEvent.mouseDown(options()[1]!)).toBe(false);
    expect(fireEvent.mouseDown(newBox())).toBe(true);
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(focused);
  });

  it('makes a category from New category on Enter and picks it; a blank box does nothing', () => {
    const { onChange, pick } = renderChip();
    fireEvent.click(chip());
    const box = newBox();
    key(box, 'Enter');
    expect(pick.create).toHaveBeenCalledWith('');
    expect(onChange).not.toHaveBeenCalled();
    expect(isOpen()).toBe(true);
    fireEvent.change(box, { target: { value: 'Follow ups' } });
    // An input method's Enter picks its candidate and makes nothing.
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    expect(pick.create).toHaveBeenCalledTimes(1);
    key(box, 'Enter');
    expect(pick.create).toHaveBeenLastCalledWith('Follow ups');
    expect(onChange).toHaveBeenCalledExactlyOnceWith(NEW_CATEGORY);
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(chip());
  });

  it('keeps the tab stop on the focused option when a read drops one before it, and on the first when it drops that one', () => {
    const { reread } = renderChip(ADMIN.uid);
    fireEvent.click(chip());
    expect(focusedName()).toBe('Admin');
    const stop = () =>
      options()
        .filter((o) => o.tabIndex === 0)
        .map((o) => o.textContent);
    reread([{ ...TICKETS, archived: true }, ADMIN, KB]);
    expect(stop()).toEqual(['Admin']);
    key(document.activeElement!, 'ArrowDown');
    expect(stop()).toEqual(['Knowledge base']);
    reread([ADMIN]);
    expect(stop()).toEqual(['No category']);
  });

  it('shows a removed category as set, offered in the list as "(removed)" and nowhere else', () => {
    const old = makeCategory('cat000000009', 'Old work', { color: 'gold', archived: true });
    renderChip(old.uid, [...CATS, old]);
    expect(chip().textContent).toBe('Old work');
    fireEvent.click(chip());
    expect(optionNames()).toEqual(['No category', 'Tickets', 'Admin', 'Knowledge base', 'Old work (removed)']);
    expect(focusedName()).toBe('Old work (removed)');
    cleanup();
    renderChip(null, [...CATS, old]);
    fireEvent.click(chip());
    expect(optionNames()).not.toContain('Old work (removed)');
  });
});
