import { describe, expect, it } from 'vitest';
import { sameText } from './text.js';

describe('sameText', () => {
  it('keys text by its words, whatever the case or spacing', () => {
    expect(sameText('  Call   the\tBank ')).toBe('call the bank');
    expect(sameText('Call the bank')).toBe(sameText('call THE bank'));
  });

  it('keys blank text as empty', () => {
    expect(sameText(' \t ')).toBe('');
  });
});
