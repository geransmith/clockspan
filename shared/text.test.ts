import { describe, expect, it } from 'vitest';
import { LIMITS } from './api.js';
import { categoryName, cutText, hasNote, noteStart, sameText, taskNote, taskTitle } from './text.js';

describe('sameText', () => {
  it('keys text by its words, whatever the case or spacing', () => {
    expect(sameText('  Call   the\tBank ')).toBe('call the bank');
    expect(sameText('Call the bank')).toBe(sameText('call THE bank'));
  });

  it('keys blank text as empty', () => {
    expect(sameText(' \t ')).toBe('');
  });
});

describe('cutText', () => {
  it('cuts at the limit, keeping a whole emoji and replacing half of one the cut split', () => {
    expect(cutText('abcdef', 3)).toBe('abc');
    expect(cutText('x😀', 2)).toBe('x�');
    expect(cutText('😀 x', 9)).toBe('😀 x');
  });
});

describe('categoryName', () => {
  it('trims and collapses inner spaces, keeping the case', () => {
    expect(categoryName('  Follow   ups\t')).toBe('Follow ups');
    expect(categoryName(' \t ')).toBe('');
  });

  it('cuts a long name to the limit, with no space or half a character left at the cut', () => {
    expect(categoryName('x'.repeat(LIMITS.categoryName + 5))).toBe('x'.repeat(LIMITS.categoryName));
    expect(categoryName(`${'x'.repeat(LIMITS.categoryName - 1)} y`)).toBe('x'.repeat(LIMITS.categoryName - 1));
    expect(categoryName(`${'x'.repeat(LIMITS.categoryName - 1)}😀`)).toBe(`${'x'.repeat(LIMITS.categoryName - 1)}�`);
  });
});

describe('taskTitle', () => {
  it('trims, keeps inner spaces, and cuts a long name with no space or half a character left at the cut', () => {
    expect(taskTitle('  Call  the bank ')).toBe('Call  the bank');
    expect(taskTitle(' \t ')).toBe('');
    expect(taskTitle(`  ${'x'.repeat(LIMITS.priorityText - 1)} y`)).toBe('x'.repeat(LIMITS.priorityText - 1));
    expect(taskTitle(`${'x'.repeat(LIMITS.priorityText - 1)}😀`)).toBe(`${'x'.repeat(LIMITS.priorityText - 1)}�`);
  });
});

describe('taskNote', () => {
  it('keeps line breaks, tabs and the spaces around the text, and drops the other control characters', () => {
    expect(taskNote('  Acme:\tlogs\u0000\u0007\r\nGlobex\u007f\u0085 \n')).toBe('  Acme:\tlogs\nGlobex \n');
    expect(taskNote('')).toBe('');
  });

  it('cuts at the limit, and replaces a lone surrogate, one the cut split included', () => {
    expect(taskNote('x'.repeat(LIMITS.itemNote + 5))).toBe('x'.repeat(LIMITS.itemNote));
    expect(taskNote('a\ud800b\udc00')).toBe('a\ufffdb\ufffd');
    expect(taskNote(`${'x'.repeat(LIMITS.itemNote - 1)}😀`)).toBe(`${'x'.repeat(LIMITS.itemNote - 1)}\ufffd`);
    expect(taskNote('😀')).toBe('😀');
  });
});

describe('hasNote', () => {
  it('counts a note with words, not one of spaces and line breaks alone', () => {
    expect([hasNote('Ask Kim'), hasNote(' \n\t'), hasNote('')]).toEqual([true, false, false]);
  });
});

describe('noteStart', () => {
  it('trims a note and keeps its line breaks, and gives none for a blank one', () => {
    expect(noteStart('\n  Acme: logs.\nGlobex: workaround. \n')).toBe('Acme: logs.\nGlobex: workaround.');
    expect(noteStart(' \n\t')).toBe('');
  });

  it('cuts after 200 units or eight lines, with no space left at the cut, and ends a cut one in …', () => {
    expect(noteStart('x'.repeat(200))).toBe('x'.repeat(200));
    expect(noteStart(`${'x'.repeat(198)}  y`)).toBe(`${'x'.repeat(198)}…`);
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}`).join('\n');
    expect(noteStart(lines(8))).toBe(lines(8));
    expect(noteStart(lines(9))).toBe(`${lines(8)}…`);
    // An emoji the cut would split goes whole.
    expect(noteStart(`${'x'.repeat(199)}😀`)).toBe(`${'x'.repeat(199)}…`);
  });
});
