import { describe, expect, it } from 'vitest';
import { LIMITS } from './api.js';
import { categoryName, sameText, taskTitle } from './text.js';

describe('sameText', () => {
  it('keys text by its words, whatever the case or spacing', () => {
    expect(sameText('  Call   the\tBank ')).toBe('call the bank');
    expect(sameText('Call the bank')).toBe(sameText('call THE bank'));
  });

  it('keys blank text as empty', () => {
    expect(sameText(' \t ')).toBe('');
  });
});

describe('categoryName', () => {
  it('trims and collapses inner spaces, keeping the case', () => {
    expect(categoryName('  Follow   ups\t')).toBe('Follow ups');
    expect(categoryName(' \t ')).toBe('');
  });

  it('cuts a long name to the limit, with no space left at the cut', () => {
    expect(categoryName('x'.repeat(LIMITS.categoryName + 5))).toBe('x'.repeat(LIMITS.categoryName));
    expect(categoryName(`${'x'.repeat(LIMITS.categoryName - 1)} y`)).toBe('x'.repeat(LIMITS.categoryName - 1));
  });
});

describe('taskTitle', () => {
  it('trims, keeps inner spaces, and cuts a long name with no space left at the cut', () => {
    expect(taskTitle('  Call  the bank ')).toBe('Call  the bank');
    expect(taskTitle(' \t ')).toBe('');
    expect(taskTitle(`  ${'x'.repeat(LIMITS.priorityText - 1)} y`)).toBe('x'.repeat(LIMITS.priorityText - 1));
  });
});
