import { describe, expect, it } from 'vitest';
import { placePopover, POPOVER_MARGIN, type Box } from './popover';

const VIEWPORT = { width: 400, height: 800 };
/** A 28 px chip whose top edge is at `top` and right edge at `right`. */
const chip = (top: number, right = 300): Box => ({ top, bottom: top + 28, right });
/** The list's size with its box: a list bounded at 288 px, the box and the padding. */
const LIST = { width: 240, height: 360 };

describe('placePopover', () => {
  it("goes under the control, its right edge on the control's", () => {
    expect(placePopover(chip(100), LIST, VIEWPORT)).toEqual({ top: 132, left: 60 });
  });

  it('flips above a control near the bottom, where the bounded list fits above and not below', () => {
    expect(placePopover(chip(600), LIST, VIEWPORT)).toEqual({ top: 600 - 4 - 360, left: 60 });
  });

  it('stays under when it fits neither way, moved up to stay inside the viewport', () => {
    const short = { width: 400, height: 500 };
    expect(placePopover(chip(200), LIST, short)).toEqual({ top: 500 - POPOVER_MARGIN - 360, left: 60 });
    // Taller than the viewport allows: its top edge stays in view.
    expect(placePopover(chip(200), { width: 240, height: 600 }, short).top).toBe(POPOVER_MARGIN);
  });

  it('stays inside the left and right edges', () => {
    expect(placePopover(chip(100, 150), LIST, VIEWPORT).left).toBe(POPOVER_MARGIN);
    expect(placePopover(chip(100, 420), LIST, VIEWPORT).left).toBe(400 - POPOVER_MARGIN - 240);
  });
});
