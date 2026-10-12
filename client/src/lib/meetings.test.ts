import { describe, expect, it } from 'vitest';
import { HOUR_MS } from '../../../shared/dates.js';
import { dayMeetings } from './meetings';

const T0 = Date.UTC(2026, 9, 12, 16);
const at = (h: number, title = '') => ({ title, startsAt: T0 + h * HOUR_MS, endsAt: T0 + (h + 1) * HOUR_MS });

describe('dayMeetings', () => {
  it('lists the meetings by start, then end, leaving out the ones taken off the day', () => {
    const long = { ...at(1), endsAt: T0 + 3 * HOUR_MS };
    expect(dayMeetings({ c: at(2), gone: null, b: long, a: at(1) })).toEqual([
      ['a', at(1)],
      ['b', long],
      ['c', at(2)],
    ]);
    expect(dayMeetings({})).toEqual([]);
  });
});
