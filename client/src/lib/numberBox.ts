/** A number box's text as a number, NaN when blank: `Number('')` is 0, which would save a cleared box as the minimum. */
export const boxNumber = (text: string): number => (text.trim() === '' ? NaN : Number(text));

/** What a number box commits: `typed` rounded and kept within `min`–`max`, or `stored` when a box was blank or not a number. */
export const committedNumber = (typed: number, min: number, max: number, stored: number): number =>
  Number.isFinite(typed) ? Math.max(min, Math.min(max, Math.round(typed))) : stored;
