import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../dev/harness.js';
import { breaksRouter } from './breaks.js';
import { sessionsRouter } from './sessions.js';

const DATE = '2026-09-01';

describe('the ownership check on /sessions/:id and /breaks/:id', () => {
  let app: TestApp;
  beforeEach(async () => {
    app = await startTestApp({ authMode: 'local' });
  });
  afterEach(() => app.close());

  /** A's finished session and running break, and both users signed in. */
  const setUp = async () => {
    const users = await app.twoUsers();
    const session = (await users.a.post(`/api/days/${DATE}/sessions`, { plannedSeconds: 900 })).body.session as { id: number };
    await users.a.post(`/api/sessions/${session.id}/finish`);
    const brk = (await users.a.post(`/api/days/${DATE}/breaks`, { plannedSeconds: 300 })).body.break as { id: number };
    return { ...users, session, brk };
  };

  it('covers a route added with no guard of its own', async () => {
    const { admin, member, session, brk } = await setUp();
    // Each router as app.ts mounts it, plus a route that lists nothing before its handler.
    const probe: express.RequestHandler = (_req, res) => {
      res.json({ ok: true });
    };
    const mini = express()
      .use((req, _res, next) => {
        req.user = req.get('x-user') === 'b' ? member : admin;
        next();
      })
      .use('/sessions', sessionsRouter(app.db).get('/:id/probe', probe))
      .use('/breaks', breaksRouter(app.db).get('/:id/probe', probe));
    const server = mini.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const get = async (path: string, user: 'a' | 'b') => {
      const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, { headers: { 'x-user': user } });
      return [r.status, await r.json()];
    };
    try {
      expect(await get(`/sessions/${session.id}/probe`, 'a')).toEqual([200, { ok: true }]);
      expect(await get(`/sessions/${session.id}/probe`, 'b')).toEqual([404, { error: 'Session not found.' }]);
      expect(await get(`/breaks/${brk.id}/probe`, 'a')).toEqual([200, { ok: true }]);
      expect(await get(`/breaks/${brk.id}/probe`, 'b')).toEqual([404, { error: 'Break not found.' }]);
    } finally {
      server.close();
    }
  });

  it('answers 404 for an id that names no row, whatever it looks like', async () => {
    const { a } = await setUp();
    const ids = ['abc', '1.5', '-1', '0', '%20', '9'.repeat(30), '1'.repeat(400)];
    for (const id of ids) {
      const sessions = [
        a.patch(`/api/sessions/${id}`, { label: 'x' }),
        a.post(`/api/sessions/${id}/pause`),
        a.post(`/api/sessions/${id}/resume`),
        a.post(`/api/sessions/${id}/finish`),
        a.post(`/api/sessions/${id}/cancel`),
        a.del(`/api/sessions/${id}`),
      ];
      for (const r of await Promise.all(sessions)) expect([id, r.status, r.body]).toEqual([id, 404, { error: 'Session not found.' }]);
      for (const r of await Promise.all([a.post(`/api/breaks/${id}/end`), a.del(`/api/breaks/${id}`)])) {
        expect([id, r.status, r.body]).toEqual([id, 404, { error: 'Break not found.' }]);
      }
    }
    // A method no /:id route takes never reaches the check: it is the API's plain 404.
    expect((await a.get('/api/sessions/1')).body).toEqual({ error: 'Not found.' });
  });
});
