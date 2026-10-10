import { expect, it } from 'vitest';
import { boxNumber, committedNumber } from './numberBox';

const commit = (text: string) => committedNumber(boxNumber(text), 30, 3650, 365);

it('gives the stored value back for a blank or non-numeric box', () => {
  expect(commit('')).toBe(365);
  expect(commit('  ')).toBe(365);
  expect(commit('9o')).toBe(365);
  expect(commit('Infinity')).toBe(365);
});

it('commits a whole number inside its bounds', () => {
  expect(commit(' 45.6 ')).toBe(46);
  expect(commit('10')).toBe(30);
  expect(commit('5000')).toBe(3650);
  expect(committedNumber(boxNumber('0'), 0, 10, 5)).toBe(0);
});
