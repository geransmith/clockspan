import { useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { LIMITS } from '../../../shared/api.js';
import { activeCategories, categoryOf, type CategoryPick } from '../lib/board';
import { placePopover } from '../lib/popover';
import type { CategoryColor } from '../types';
import { CategoryDot } from './CategoryDot';
import { Check } from './Icons';

interface Props {
  /** The category set, or null for none; a uid the board doesn't hold reads as none. */
  value: string | null;
  onChange: (uid: string | null) => void;
  pick: CategoryPick;
  /** What the category is for ("Category for new cards"): the chip is named "{label}: {name}", or "{label}: none". */
  label: string;
}

interface Option {
  uid: string | null;
  name: string;
  color: CategoryColor | null;
}

/** Puts a list where `placePopover` says, measured as its control and the list are now: the chip's, and the timer's suggestions. */
export function placeList(anchor: HTMLElement | null, list: HTMLElement | null): void {
  if (!anchor || !list) return;
  const { top, left } = placePopover(
    anchor.getBoundingClientRect(),
    { width: list.offsetWidth, height: list.offsetHeight },
    { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
  );
  list.style.top = `${top}px`;
  list.style.left = `${left}px`;
}

/** Focuses option `i` of the list, or the one in the tab order; native focus() also scrolls it into view inside the list. */
function focusOption(list: HTMLElement | null, i?: number): void {
  const option =
    i === undefined ? list?.querySelector<HTMLElement>('[role="option"][tabindex="0"]') : list?.querySelectorAll<HTMLElement>('[role="option"]')[i];
  option?.focus();
}

/**
 * The one way a category is picked: a chip that shows it (its dot and name, or a dashed
 * "Category" for none) and opens a list of "No category" and the categories in use, with a New
 * category box under it whose Enter makes one (or picks the one in use by that name) and picks it.
 *
 * The list is a listbox with roving focus: the arrows move without wrapping, Home and End jump,
 * Enter or Space picks, and Tab goes on to the box. It is rendered inside the chip's wrapper, so a
 * check for focus within the chip's row still holds while the list has it, and placed
 * `position: fixed` with script, so a card's or a dialog's overflow can't clip it. Escape, a press
 * outside, or the focus moving to something else closes it with no change; Escape goes no
 * further, so a dialog around it stays open. Opening reads the board again (`pick.refresh`), so a
 * category made on another device is offered.
 */
export function CategoryChip({ value, onChange, pick, label }: Props) {
  const [open, setOpen] = useState(false);
  // The option in the tab order while the list is open: the selected one, then where the keys moved.
  const [active, setActive] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const wrap = useRef<HTMLSpanElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const listId = useId();

  const current = categoryOf(pick.categories, value);
  const selected = current?.uid ?? null;
  const options: Option[] = [
    { uid: null, name: 'No category', color: null },
    ...activeCategories(pick.categories),
    // A removed category is never offered, but the one set still shows as set.
    ...(current?.archived ? [{ uid: current.uid, name: `${current.name} (removed)`, color: current.color }] : []),
  ];
  // By uid, as the re-read on opening can add or drop a category before it; one dropped hands the stop to the first.
  const at = Math.max(
    0,
    options.findIndex((o) => o.uid === active),
  );

  // After every render while open, since the re-read can grow the list, and on any scroll or resize.
  useLayoutEffect(() => {
    if (open) placeList(chip.current, pop.current);
  });
  useEffect(() => {
    if (!open) return;
    const follow = () => placeList(chip.current, pop.current);
    const outside = (e: PointerEvent) => {
      if (wrap.current?.contains(e.target as Node)) return;
      // The list goes before the press's mousedown moves the focus, and the focused option with
      // it: the focus would fall to the page with no blur React reports, so a box that ends its
      // edit when the focus leaves it (a day log row's) would never hear it go. On the chip, the
      // mousedown moves it on from inside that box.
      if (pop.current?.contains(document.activeElement)) chip.current?.focus({ preventScroll: true });
      setOpen(false);
    };
    window.addEventListener('scroll', follow, true);
    window.addEventListener('resize', follow);
    document.addEventListener('pointerdown', outside, true);
    return () => {
      window.removeEventListener('scroll', follow, true);
      window.removeEventListener('resize', follow);
      document.removeEventListener('pointerdown', outside, true);
    };
  }, [open]);
  // Only as the list opens; after that the keys move the focus. The re-read can change the list
  // while the focus is in the New category box, and must not take it from there mid-word.
  useEffect(() => {
    if (open) focusOption(pop.current);
  }, [open]);

  const openList = () => {
    pick.refresh();
    setDraft('');
    setActive(selected);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    chip.current?.focus();
  };
  const choose = (uid: string | null) => {
    if (uid !== value) onChange(uid);
    close();
  };

  // Escape closes the list and stops there: the dialog or editor around it stays open.
  const escape = (e: KeyboardEvent) => {
    if (!open || e.key !== 'Escape' || e.nativeEvent.isComposing) return false;
    e.preventDefault();
    e.stopPropagation();
    close();
    return true;
  };
  // Focus moving to something outside closes it, as a press outside does (the pointerdown above);
  // a press inside leaves the focus where it is (the list's mousedown). Focus going nowhere (the
  // window losing it) leaves the list open.
  const leave = (e: FocusEvent) => {
    if (open && e.relatedTarget && !wrap.current?.contains(e.relatedTarget)) setOpen(false);
  };
  const onOptionKey = (e: KeyboardEvent, i: number) => {
    if (escape(e)) return;
    const last = options.length - 1;
    const to = new Map([
      ['ArrowDown', Math.min(i + 1, last)],
      ['ArrowUp', Math.max(i - 1, 0)],
      ['Home', 0],
      ['End', last],
    ]).get(e.key);
    if (to !== undefined) {
      e.preventDefault();
      setActive(options[to]!.uid);
      focusOption(pop.current, to);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      choose(options[i]!.uid);
    }
  };

  return (
    <span ref={wrap} className="category-wrap">
      <button
        ref={chip}
        type="button"
        className={current ? 'chip category-chip' : 'chip category-chip category-chip--empty'}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`${label}: ${current?.name ?? 'none'}`}
        title={current?.name}
        onClick={() => (open ? close() : openList())}
        // Safari, and Firefox on macOS, don't focus a button they press, so the focus would leave
        // for the page, and a box that ends its edit when the focus leaves it (a day log row's)
        // would end it. A press leaves the focus where it is: until the list opens and takes it,
        // or, open, until the list closes and gives it to the chip.
        onMouseDown={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (escape(e) || e.key !== 'ArrowDown') return;
          e.preventDefault();
          // Open, as after Shift+Tab out of the list, it goes back to the option it left.
          if (open) focusOption(pop.current);
          else openList();
        }}
        onBlur={leave}
      >
        {current ? (
          <>
            <CategoryDot color={current.color} />
            <span className="category-chip-name">{current.name}</span>
          </>
        ) : (
          'Category'
        )}
      </button>
      {open && (
        <div
          ref={pop}
          className="category-pop"
          // Nothing between the list and a day log row's box takes focus, so a press on the list's
          // padding or the gap above New category would move the focus to the page, and the box
          // would end its edit, closing the list before anything was picked. A press here leaves
          // the focus where it is: an option's click picks and gives it to the chip, and the New
          // category box still takes it. The handler only holds the focus, so the wrapper is
          // presentation to a screen reader; the listbox and the box keep their roles.
          role="presentation"
          onMouseDown={(e) => {
            if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
          }}
        >
          <div id={listId} className="category-options" role="listbox" aria-label="Category">
            {options.map((o, i) => (
              <div
                key={o.uid ?? ''}
                role="option"
                aria-selected={o.uid === selected}
                tabIndex={i === at ? 0 : -1}
                className="category-option"
                onClick={() => choose(o.uid)}
                onKeyDown={(e) => onOptionKey(e, i)}
                onBlur={leave}
              >
                {o.color && <CategoryDot color={o.color} />}
                <span className="category-option-name">{o.name}</span>
                {o.uid === selected && <Check />}
              </div>
            ))}
          </div>
          <input
            className="input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // An input method's Enter picks a candidate: it makes nothing.
              if (escape(e) || e.key !== 'Enter' || e.nativeEvent.isComposing) return;
              e.preventDefault();
              const uid = pick.create(draft);
              if (uid) choose(uid);
            }}
            onBlur={leave}
            placeholder="New category"
            aria-label="New category"
            maxLength={LIMITS.categoryName}
          />
        </div>
      )}
    </span>
  );
}
