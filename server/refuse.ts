import type { Response } from 'express';
import type { ErrorResponse } from '../shared/api.js';

/** Answers a refused request: `status`, and the message the client shows. */
export function refuse(res: Response, status: number, error: string): void {
  res.status(status).json({ error } satisfies ErrorResponse);
}

/**
 * The 409's message for a request shaped as a page loaded before tasks were stored once sends it
 * (a board card's route, a priorities save with `cards`, `touched` or a row's card link): that
 * page can't save until it reloads.
 */
export const STALE_CLIENT = 'Clockspan was updated. Reload the page.';
