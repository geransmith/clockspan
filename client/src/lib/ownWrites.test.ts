import { describe, expect, it } from 'vitest';
import { changedElsewhere, noteOwnWrite } from './ownWrites';

// The noted revisions are module state, so each case judges spans above the last one's.
describe('changedElsewhere', () => {
  it("counts a span as another tab's or device's unless this page wrote every revision in it", () => {
    noteOwnWrite(2);
    noteOwnWrite(3);
    noteOwnWrite(5);
    expect(changedElsewhere(1, 3)).toBe(false);
    // 4 was another's; 5, noted before, waited for its span.
    expect(changedElsewhere(3, 5)).toBe(true);
    expect(changedElsewhere(5, 5)).toBe(false);
  });

  it('forgets what it noted up to the span it judged, older ones included', () => {
    noteOwnWrite(10);
    noteOwnWrite(12);
    expect(changedElsewhere(11, 12)).toBe(false);
    expect(changedElsewhere(9, 10)).toBe(true);
  });
});
