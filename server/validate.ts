/**
 * A whole number from `bounds.min` to `bounds.max`. Every bounded number the server takes goes
 * through this one check: the settings, a session's or a break's planned length, a day's own
 * work-day length, and the numeric env variables (after `Number()`).
 */
export function isWholeNumber(value: unknown, bounds: { readonly min: number; readonly max: number }): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= bounds.min && value <= bounds.max;
}
