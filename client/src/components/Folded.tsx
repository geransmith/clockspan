import { useState, type ReactNode } from 'react';

/**
 * A list longer than FOLD_AT + 1 rows shows its first FOLD_AT and a Show all button. One row
 * over shows in full, since the button would take the space of the one row it hides.
 */
const FOLD_AT = 8;

/** A long list folded (Review's lists, the board's Later column); `items` are its `<li>`s. */
export function Folded({ items, className }: { items: ReactNode[]; className: string }) {
  const [open, setOpen] = useState(false);
  const folded = !open && items.length > FOLD_AT + 1;
  return (
    <>
      <ul className={className}>{folded ? items.slice(0, FOLD_AT) : items}</ul>
      {folded && (
        <button className="btn btn-ghost fold-more" onClick={() => setOpen(true)}>
          Show all {items.length}
        </button>
      )}
    </>
  );
}
