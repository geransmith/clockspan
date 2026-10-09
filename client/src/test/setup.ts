import { afterEach, vi } from 'vitest';

// The teardown every test file would otherwise repeat. A file's own afterEach runs first (Vitest
// runs after-hooks in reverse), so a file whose teardown needs the tree unmounted first calls
// cleanup() itself. RTL is loaded only where the test has a DOM, so the server's node tests never
// pull it in.
afterEach(async () => {
  if (typeof document !== 'undefined') (await import('@testing-library/react')).cleanup();
  vi.useRealTimers();
});

// happy-dom fires `selectionchange` inside `collapse()`, even for a collapse to the point already
// selected; browsers queue the event and skip an unchanged selection. React Aria's time segments
// collapse the selection on `selectionchange`, so under happy-dom the two recurse until the stack
// runs out and print a RangeError from every test that focuses a punch field. Collapsing to where
// the selection already is does nothing, as in a browser. Drop this once happy-dom fixes it.
if (typeof Selection !== 'undefined') {
  const collapse = Reflect.get(Selection.prototype, 'collapse') as (this: Selection, node: Node | null, offset?: number) => void;
  Selection.prototype.collapse = function (this: Selection, node: Node | null, offset = 0) {
    if (node && this.rangeCount > 0 && this.isCollapsed && this.anchorNode === node && this.anchorOffset === offset) return;
    collapse.call(this, node, offset);
  };
}
