/**
 * The wait before asking again after a failure, for requests that are retried until they
 * answer (the settings fetch, the timer's auto-finish, OIDC discovery): two seconds, doubling
 * up to a minute, so a server that is down is not asked every second.
 */
const FIRST_MS = 2_000;
const MAX_MS = 60_000;

/** The wait after a wait of `prev` ms. The first failure passes 0 and waits `FIRST_MS`. */
export function nextBackoff(prev: number): number {
  return prev > 0 ? Math.min(prev * 2, MAX_MS) : FIRST_MS;
}
