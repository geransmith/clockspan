import type { Response } from 'express';
import type { ErrorResponse } from '../shared/api.js';

/** Answers a refused request: `status`, and the message the client shows. */
export function refuse(res: Response, status: number, error: string): void {
  res.status(status).json({ error } satisfies ErrorResponse);
}
