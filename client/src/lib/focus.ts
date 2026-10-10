/**
 * A press that takes its own button away or turns it off (a log row's delete, a punch row's ×)
 * first hands the focus to the next button of its kind (`selector`, inside the `within` the
 * pressed one sits in) that is on, else the one before it, so the focus doesn't fall to the page.
 */
export function focusNeighbour(pressed: HTMLButtonElement, within: string, selector: string): void {
  const all = [...pressed.closest(within)!.querySelectorAll<HTMLButtonElement>(selector)];
  const at = all.indexOf(pressed);
  [...all.slice(at + 1), ...all.slice(0, at).reverse()].find((b) => !b.disabled)?.focus();
}
