import { describe, expect, it } from 'vitest';
import { seedRow } from './plan';
import { makePriority } from '../test/fixtures';

describe('seedRow', () => {
  it("puts a carried row's own task on the list, in its category with its note, with its counts until the save answers", () => {
    const source = makePriority(2, 'Invoices', {
      uid: 'task00000001',
      addedAt: 5,
      categoryUid: 'cafe00000001',
      note: 'Ask Kim',
      listed: 2,
      earlier: 1,
      logged: 1500,
    });
    const { position: _position, ...row } = source;
    expect(seedRow(source, 99)).toEqual({ ...row, addedAt: 99 });
  });
});
