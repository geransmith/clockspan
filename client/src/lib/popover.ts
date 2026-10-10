/**
 * Where a small list opened from a control goes on screen: the category chip's list and the
 * timer's label suggestions, which are `position: fixed` so a card's or a dialog's overflow can't
 * clip them. Pure, so the flip and the edges are tested without a layout engine; `placeList`
 * (`CategoryChip.tsx`) measures and calls it.
 */

/** A box on screen in viewport pixels, as `getBoundingClientRect()` gives it. */
export type Box = Pick<DOMRectReadOnly, 'top' | 'right' | 'bottom'>;

interface Size {
  width: number;
  height: number;
}

/** How far the list stays from the viewport's edges. */
export const POPOVER_MARGIN = 8;
/** The space between the control and its list. */
const GAP = 4;

/**
 * The list's top-left corner: under the control with their right edges lined up, or above it
 * when it fits there and not below; then moved, if it must, to stay `POPOVER_MARGIN` inside the
 * viewport (the top edge first when the list is taller than the viewport allows).
 */
export function placePopover(anchor: Box, size: Size, viewport: Size): { top: number; left: number } {
  const below = anchor.bottom + GAP;
  const above = anchor.top - GAP - size.height;
  const fitsBelow = below + size.height <= viewport.height - POPOVER_MARGIN;
  const top = !fitsBelow && above >= POPOVER_MARGIN ? above : below;
  return {
    top: within(top, viewport.height - POPOVER_MARGIN - size.height),
    left: within(anchor.right - size.width, viewport.width - POPOVER_MARGIN - size.width),
  };
}

/** `at` moved back to `max` when past it, then up to the margin when before it. */
function within(at: number, max: number): number {
  return Math.max(POPOVER_MARGIN, Math.min(at, max));
}
