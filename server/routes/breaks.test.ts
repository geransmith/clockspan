import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../dev/harness.js';
import { ensureLocalUsers, LOCAL_USERS } from '../dev/seed.js';

const DATE = '2026-09-01';
const MIN = 60_000;

describe('breaks', () => {
  let app: TestApp;
  beforeEach(async () => {
    app = await startTestApp();
  });
  afterEach(() => app.close());

  const start = (body: Record<string, unknown> = { plannedSeconds: 300 }) => app.api.post(`/api/days/${DATE}/breaks`, body);
  const day = async () => (await app.api.get(`/api/days/${DATE}`)).body;
  /** Moves a break into the past, as if it started `ago` minutes back. */
  const startedAgo = (id: number, ago: number, minutes: number) =>
    app.db.prepare(`UPDATE breaks SET started_at = ?, ended_at = ? WHERE id = ?`).run(Date.now() - ago * MIN, Date.now() - (ago - minutes) * MIN, id);

  it('starts a break now and logs it on the day, ending at its planned length', async () => {
    const before = Date.now();
    const r = await start();
    expect(r.status).toBe(201);
    const b = r.body.break;
    expect(b).toMatchObject({ date: DATE, plannedSeconds: 300 });
    expect(b.startedAt).toBeGreaterThanOrEqual(before);
    expect(b.endedAt).toBe(b.startedAt + 300_000);
    expect((await day()).breaks).toEqual([b]);
  });

  it('validates the length and the date', async () => {
    expect((await start({ plannedSeconds: 59 })).status).toBe(400);
    expect((await start({ plannedSeconds: 3601 })).status).toBe(400);
    expect((await start({ plannedSeconds: 90.5 })).status).toBe(400);
    expect((await start({ plannedSeconds: '300' })).status).toBe(400);
    expect((await fetch(`${app.url}/api/days/${DATE}/breaks`, { method: 'POST' })).status).toBe(400);
    expect((await app.api.post('/api/days/nope/breaks', { plannedSeconds: 300 })).status).toBe(400);
    expect((await start({ plannedSeconds: 3600 })).status).toBe(201);
  });

  it('refuses a break while a focus timer runs', async () => {
    const { id } = (await app.api.post(`/api/days/${DATE}/sessions`, { plannedSeconds: 1500 })).body.session;
    const r = await start();
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/timer/);
    await app.api.post(`/api/sessions/${id}/finish`);
    expect((await start()).status).toBe(201);
  });

  it('ends a break still running when the next one starts, and drops it if it ran under a minute', async () => {
    const first = (await start()).body.break;
    startedAgo(first.id, 2, 5);
    const second = (await start({ plannedSeconds: 600 })).body.break;
    const [a, b] = (await day()).breaks;
    expect(a).toMatchObject({ id: first.id, endedAt: second.startedAt });
    expect(b).toEqual(second);
    // Seconds old: pressed by mistake, so the next one replaces it in the log.
    const third = (await start({ plannedSeconds: 300 })).body.break;
    expect((await day()).breaks.map((x: { id: number }) => x.id)).toEqual([first.id, third.id]);
  });

  it('ends a break when a focus session starts, on any device, and drops one under a minute', async () => {
    const { id } = (await start()).body.break;
    startedAgo(id, 2, 5);
    const session = (await app.api.post(`/api/days/${DATE}/sessions`, { plannedSeconds: 1500 })).body.session;
    expect((await day()).breaks[0]).toMatchObject({ id, endedAt: session.startedAt });
    await app.api.post(`/api/sessions/${session.id}/finish`);
    await start();
    const next = (await app.api.post(`/api/days/${DATE}/sessions`, { plannedSeconds: 1500 })).body.session;
    expect(next.status).toBe('running');
    expect((await day()).breaks.map((x: { id: number }) => x.id)).toEqual([id]);
  });

  it('drops a break ended within a minute instead of logging it', async () => {
    const { id } = (await start()).body.break;
    const r = await app.api.post(`/api/breaks/${id}/end`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ break: null });
    expect((await day()).breaks).toEqual([]);
    expect((await app.api.post(`/api/breaks/${id}/end`)).status).toBe(404);
    // A minute is enough to keep.
    const kept = (await start()).body.break;
    startedAgo(kept.id, 1, 5);
    expect((await app.api.post(`/api/breaks/${kept.id}/end`)).body.break.id).toBe(kept.id);
  });

  it('ends a break early, once, and leaves one that already ran out alone', async () => {
    const { id } = (await start()).body.break;
    startedAgo(id, 2, 5);
    const ended = await app.api.post(`/api/breaks/${id}/end`);
    expect(ended.status).toBe(200);
    const { startedAt, endedAt } = ended.body.break;
    expect(endedAt - startedAt).toBeGreaterThanOrEqual(2 * MIN);
    expect(endedAt - startedAt).toBeLessThan(3 * MIN);
    expect((await app.api.post(`/api/breaks/${id}/end`)).body.break.endedAt).toBe(endedAt);

    const over = (await start()).body.break;
    startedAgo(over.id, 10, 5);
    const stored = (await day()).breaks.find((b: { id: number }) => b.id === over.id);
    expect((await app.api.post(`/api/breaks/${over.id}/end`)).body.break).toEqual(stored);
    expect(stored.endedAt - stored.startedAt).toBe(5 * MIN);
  });

  it('deletes a break from the log', async () => {
    const { id } = (await start()).body.break;
    const r = await app.api.del(`/api/breaks/${id}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect((await day()).breaks).toEqual([]);
    expect((await app.api.del(`/api/breaks/${id}`)).status).toBe(404);
    expect((await app.api.post(`/api/breaks/${id}/end`)).status).toBe(404);
  });
});

describe('breaks are scoped to the signed-in user', () => {
  let app: TestApp;
  beforeEach(async () => {
    app = await startTestApp({ authMode: 'local' });
  });
  afterEach(() => app.close());

  it("hides one user's breaks from another", async () => {
    await ensureLocalUsers(app.db);
    const a = app.client();
    const b = app.client();
    expect((await a.post('/api/auth/login', { username: LOCAL_USERS.admin, password: LOCAL_USERS.password })).status).toBe(200);
    expect((await b.post('/api/auth/login', { username: LOCAL_USERS.member, password: LOCAL_USERS.password })).status).toBe(200);

    const { id } = (await a.post(`/api/days/${DATE}/breaks`, { plannedSeconds: 300 })).body.break;
    expect((await b.get(`/api/days/${DATE}`)).body.breaks).toEqual([]);
    expect((await b.get(`/api/days/range?from=${DATE}&to=${DATE}`)).body.days).toEqual([]);
    expect(await b.post(`/api/breaks/${id}/end`)).toMatchObject({ status: 404, body: { error: 'Break not found.' } });
    expect((await b.del(`/api/breaks/${id}`)).status).toBe(404);
    // B's own break doesn't end A's, and B's timer doesn't either.
    expect((await b.post(`/api/days/${DATE}/breaks`, { plannedSeconds: 600 })).status).toBe(201);
    await b.post(`/api/days/${DATE}/sessions`, { plannedSeconds: 1500 });
    const mine = (await a.get(`/api/days/${DATE}`)).body.breaks;
    expect(mine).toHaveLength(1);
    expect(mine[0].endedAt - mine[0].startedAt).toBe(300_000);
    expect((await a.get(`/api/days/range?from=${DATE}&to=${DATE}`)).body.days[0].breaks).toEqual(mine);
  });
});
