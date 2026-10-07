/**
 * A whole number from `bounds.min` to `bounds.max`. Every bounded whole number the server takes
 * goes through this one check: the settings, a session's or a break's planned length, a day's own
 * work-day length, and the env variables that are whole numbers (after `Number()`).
 */
export function isWholeNumber(value: unknown, bounds: { readonly min: number; readonly max: number }): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= bounds.min && value <= bounds.max;
}

/** One of a fixed list of strings: a setting's choices, a category's colours. */
export function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return list.includes(value as T);
}
