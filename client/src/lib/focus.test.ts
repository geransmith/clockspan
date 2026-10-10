// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { focusNeighbour } from './focus';

/** Four buttons in a list, the ones named in `off` disabled. */
function buttons(...off: number[]): HTMLButtonElement[] {
  document.body.innerHTML = `<ul>${[0, 1, 2, 3].map((i) => `<li><button class="del"${off.includes(i) ? ' disabled' : ''}>${i}</button></li>`).join('')}</ul>`;
  return [...document.querySelectorAll('button')];
}

describe('focusNeighbour', () => {
  it('goes to the next button that is on, else back to the one before, past those that are off', () => {
    let all = buttons(2);
    focusNeighbour(all[1]!, 'ul', '.del');
    expect(document.activeElement).toBe(all[3]);
    all = buttons(0, 3);
    focusNeighbour(all[2]!, 'ul', '.del');
    expect(document.activeElement).toBe(all[1]);
  });

  it('leaves the focus where it is when no other is on', () => {
    const all = buttons(0, 2, 3);
    all[1]!.focus();
    focusNeighbour(all[1]!, 'ul', '.del');
    expect(document.activeElement).toBe(all[1]);
  });
});
