import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEED_NOW, startTestApp, type TestApp } from '../dev/harness.js';
import { MINUTE_MS } from '../../shared/dates.js';

const DATE = '2026-09-01';

describe('breaks', () => {
  let app: TestApp;
  beforeEach(async () => {
    // Only Date: the server reads the same clock in this process, and HTTP keeps its real timers.
    vi.useFakeTimers({ now: SEED_NOW, toFake: ['Date'] });
    app = await startTestApp();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
  });

  /** Moves the clock to `ms` after the test's start. */
  const at = (ms: number) => vi.setSystemTime(SEED_NOW + ms);
  const start = (body: Record<string, unknown> = { plannedSeconds: 300 }) => app.api.post(`/api/days/${DATE}/breaks`, body);
  const day = async () => (await app.api.get(`/api/days/${DATE}`)).body;

  it('starts a break now and logs it on the day, ending at its planned length', async () => {
    const r = await start();
    expect(r.status).toBe(201);
    const b = r.body.break;
    expect(b).toMatchObject({ date: DATE, plannedSeconds: 300, startedAt: SEED_NOW, endedAt: SEED_NOW + 300_000 });
    expect((await day()).breaks).toEqual([b]);
  });

  it('validates the length', async () => {
    expect((await start({ plannedSeconds: 59 })).status).toBe(400);
    expect((await start({ plannedSeconds: 3601 })).status).toBe(400);
    expect((await start({ plannedSeconds: 90.5 })).status).toBe(400);
    expect((await start({ plannedSeconds: '300' })).status).toBe(400);
    expect((await app.api.post(`/api/days/${DATE}/breaks`)).status).toBe(400);
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
    at(2 * MINUTE_MS);
    const second = (await start({ plannedSeconds: 600 })).body.break;
    expect(second.startedAt).toBe(SEED_NOW + 2 * MINUTE_MS);
    const [a, b] = (await day()).breaks;
    expect(a).toMatchObject({ id: first.id, endedAt: second.startedAt });
    expect(b).toEqual(second);
    // Seconds old: pressed by mistake, so the next one replaces it in the log.
    at(2 * MINUTE_MS + 10_000);
    const third = (await start({ plannedSeconds: 300 })).body.break;
    expect((await day()).breaks.map((x: { id: number }) => x.id)).toEqual([first.id, third.id]);
  });

  it('ends a break when a focus session starts, on any device, and drops one under a minute', async () => {
    const { id } = (await start()).body.break;
    at(2 * MINUTE_MS);
    const session = (await app.api.post(`/api/days/${DATE}/sessions`, { plannedSeconds: 1500 })).body.session;
    expect(session.startedAt).toBe(SEED_NOW + 2 * MINUTE_MS);
    expect((await day()).breaks[0]).toMatchObject({ id, endedAt: session.startedAt });
    await app.api.post(`/api/sessions/${session.id}/finish`);
    await start();
    at(2 * MINUTE_MS + 10_000);
    const next = (await app.api.post(`/api/days/${DATE}/sessions`, { plannedSeconds: 1500 })).body.session;
    expect(next.status).toBe('running');
    expect((await day()).breaks.map((x: { id: number }) => x.id)).toEqual([id]);
  });

  it('drops a break ended within a minute instead of logging it', async () => {
    const { id } = (await start()).body.break;
    at(59_999);
    const r = await app.api.post(`/api/breaks/${id}/end`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ break: null });
    expect((await day()).breaks).toEqual([]);
    expect((await app.api.post(`/api/breaks/${id}/end`)).status).toBe(404);
    // A minute is enough to keep.
    at(100_000);
    const kept = (await start()).body.break;
    at(160_000);
    expect((await app.api.post(`/api/breaks/${kept.id}/end`)).body.break).toMatchObject({
      id: kept.id,
      startedAt: SEED_NOW + 100_000,
      endedAt: SEED_NOW + 160_000,
    });
  });

  it('ends a break early, once, and leaves one that already ran out alone', async () => {
    const { id } = (await start()).body.break;
    at(2 * MINUTE_MS);
    const ended = await app.api.post(`/api/breaks/${id}/end`);
    expect(ended.status).toBe(200);
    expect(ended.body.break).toMatchObject({ startedAt: SEED_NOW, endedAt: SEED_NOW + 2 * MINUTE_MS });
    at(3 * MINUTE_MS);
    expect((await app.api.post(`/api/breaks/${id}/end`)).body.break.endedAt).toBe(SEED_NOW + 2 * MINUTE_MS);

    // A five-minute break that ran out five minutes ago keeps its planned end.
    const over = (await start()).body.break;
    at(13 * MINUTE_MS);
    const stored = (await day()).breaks.find((b: { id: number }) => b.id === over.id);
    expect((await app.api.post(`/api/breaks/${over.id}/end`)).body.break).toEqual(stored);
    expect(stored).toMatchObject({ startedAt: SEED_NOW + 3 * MINUTE_MS, endedAt: SEED_NOW + 8 * MINUTE_MS });
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
    const { a, b } = await app.twoUsers();

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
