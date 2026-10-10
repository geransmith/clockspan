import type { Response } from 'express';
import { refuse } from './refuse.js';

/** The live streams one user may hold open at once: a tab each, while it is shown. */
export const MAX_STREAMS = 10;
/** How often every stream gets a comment, under the idle cut of nginx (60 s) and Cloudflare (100 s). */
export const PING_MS = 25_000;

/**
 * Each user's open live streams (`GET /api/changes`, server-sent events). A stream is sent the
 * user's revision when it opens and again after each of their writes has answered, never a row,
 * so a page open on another device knows to read again at once. Kept in memory: one process
 * serves every page. A stream never ends by itself, and the server's `close()` waits for every
 * open answer, so `end()` runs before it.
 */
export function changeFeed() {
  const streams = new Map<number, Set<Response>>();
  const send = (res: Response, revision: number) => res.write(`data: ${revision}\n\n`);
  return {
    open(userId: number, res: Response, revision: number): void {
      const mine = streams.get(userId) ?? new Set<Response>();
      streams.set(userId, mine);
      if (mine.size >= MAX_STREAMS) return refuse(res, 429, 'Too many live update streams open.');
      mine.add(res);
      res.on('close', () => mine.delete(res));
      // writeHead keeps the headers set before it: no-store, the version and the revision.
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });
      send(res, revision);
    },
    notify(userId: number, revision: number): void {
      for (const res of streams.get(userId) ?? []) send(res, revision);
    },
    ping(): void {
      for (const mine of streams.values()) for (const res of mine) res.write(': ping\n\n');
    },
    end(): void {
      for (const mine of streams.values()) for (const res of mine) res.end();
      // An ended answer's 'close' comes later, and a write to it before then is an uncaught error.
      streams.clear();
    },
  };
}

export type ChangeFeed = ReturnType<typeof changeFeed>;
