import { useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';

/**
 * A list longer than FOLD_AT + 1 rows shows its first FOLD_AT and a Show all button. One row
 * over shows in full, since the button would take the space of the one row it hides.
 */
const FOLD_AT = 8;

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * A long list folded (Review's lists, the board's Later column); `items` are its `<li>`s. `wrap`
 * gets how many items show and the list, and returns the list wrapped: the board's Later puts it
 * in a SortableContext of just the cards shown. `count` is the list's own length when `items`
 * holds one more or one fewer for a moment (a card dragged into or out of Later): the fold and
 * Show all follow it, so the list doesn't fold or open mid-drag.
 */
export function Folded({
  items,
  className,
  wrap,
  count = items.length,
}: {
  items: ReactNode[];
  className: string;
  wrap?: (shown: number, list: ReactNode) => ReactNode;
  count?: number;
}) {
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const folded = !open && count > FOLD_AT + 1;
  const list = (
    <ul ref={listRef} className={className}>
      {folded ? items.slice(0, FOLD_AT) : items}
    </ul>
  );
  // Show all goes once pressed, so the focus moves to the first row it showed, or the row itself
  // when nothing in it takes focus, rather than falling back to the top of the page.
  const showAll = () => {
    flushSync(() => setOpen(true));
    const row = listRef.current?.children[FOLD_AT] as HTMLElement | undefined;
    if (!row) return;
    const target = row.querySelector<HTMLElement>(FOCUSABLE) ?? row;
    if (target === row) row.setAttribute('tabindex', '-1');
    target.focus();
  };
  return (
    <>
      {wrap ? wrap(folded ? FOLD_AT : items.length, list) : list}
      {folded && (
        <button className="btn btn-ghost fold-more" onClick={showAll}>
          Show all {count}
        </button>
      )}
    </>
  );
}
