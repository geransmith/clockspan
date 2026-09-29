import { expect, it } from 'vitest';
import { nextBackoff } from './backoff.js';

it('waits two seconds first, then doubles up to a minute', () => {
  const waits: number[] = [];
  let wait = 0;
  for (let i = 0; i < 7; i++) waits.push((wait = nextBackoff(wait)));
  expect(waits).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
});
