import type { Answer } from '../api';

/**
 * What `request()` (`client/src/api.ts`) throws when the server answers with an error: the
 * status, the server's `{ error }` message, the parsed body (a 409 on start carries the
 * running session) and the user's revision the refusal names (0 when it names none). Also
 * thrown for a 2xx whose body isn't JSON (a proxy's sign-in page), with a null body. Kept apart
 * from api.ts so hook tests, which mock that module, still throw and check the real class.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
    public revision = 0,
  ) {
    super(message);
  }
}

/**
 * A delete (or a break's end) answered 404 found the row gone already, another device or a save
 * took it: what was asked, so it counts as done, with null for the answer. A note sent to a task
 * gone that way has nothing to keep it, so it counts as done too.
 */
export async function unlessGone<T>(send: Promise<T>): Promise<T | null> {
  try {
    return await send;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/**
 * `unlessGone` for a data call: the 404 keeps the refusal's revision, so the store lays the delete
 * on as done and drops a read sent before it.
 */
export async function goneAt<T>(send: Promise<Answer<T>>): Promise<Answer<T | null>> {
  try {
    return await send;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return { value: null, revision: err.revision };
    throw err;
  }
}
