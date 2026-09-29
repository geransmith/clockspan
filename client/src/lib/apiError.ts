/**
 * What `request()` (`client/src/api.ts`) throws when the server answers with an error: the
 * status, the server's `{ error }` message, and the parsed body (a 409 on start carries the
 * running session). Also thrown for a 2xx whose body isn't JSON (a proxy's sign-in page), with
 * a null body. Kept apart from api.ts so hook tests, which mock that module, still throw and
 * check the real class.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}
