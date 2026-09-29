/**
 * The wait before asking again after a failure, for requests that are retried until they
 * answer (the settings fetch, the timer's auto-finish, OIDC discovery): two seconds, doubling
 * up to a minute, so a server that is down is not asked every second.
 */
const FIRST_MS = 2_000;
const MAX_MS = 60_000;

/** The wait after one of `prev` ms; 0 for the first failure. */
export function nextBackoff(prev: number): number {
  return prev > 0 ? Math.min(prev * 2, MAX_MS) : FIRST_MS;
}
