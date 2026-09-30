import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEED_NOW, SEED_TODAY, startTestApp, type TestApp } from '../dev/harness.js';
import { seedDatabase } from '../dev/seed.js';
import { LIMITS } from '../../shared/api.js';
import { HOUR_MS } from '../../shared/dates.js';

const DATE = '2026-09-01';

describe('sessions', () => {
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
  const start = (body: Record<string, unknown> = {}) => app.api.post(`/api/days/${DATE}/sessions`, { plannedSeconds: 1500, label: 'Work', ...body });

  it('starts a timer and reports it as running', async () => {
    const r = await start();
    expect(r.status).toBe(201);
    expect(r.body.session).toMatchObject({
      date: DATE,
      label: 'Work',
      plannedSeconds: 1500,
      status: 'running',
      endedAt: null,
      durationSeconds: null,
      priorityUid: null,
      pausedSeconds: 0,
      pausedAt: null,
    });
    const running = await app.api.get('/api/sessions/running');
    expect(running.body.session.id).toBe(r.body.session.id);
    // The day now exists and lists the running session.
    expect((await app.api.get(`/api/days/${DATE}`)).body.sessions).toHaveLength(1);
  });

  it('refuses a second timer with the running one attached', async () => {
    const first = await start();
    const second = await start({ label: 'Other' });
    expect(second.status).toBe(409);
    expect(second.body.session.id).toBe(first.body.session.id);
  });

  it('validates planned time and the label', async () => {
    expect((await start({ plannedSeconds: 59 })).status).toBe(400);
    expect((await start({ plannedSeconds: 8 * 3600 + 1 })).status).toBe(400);
    expect((await start({ plannedSeconds: 90.5 })).status).toBe(400);
    const label = await start({ label: 42 });
    expect([label.status, label.body.error]).toEqual([400, 'label must be a string.']);
    // Refused before anything is stored.
    expect(app.count('days')).toBe(0);
    // No body at all: the same 400, not a crash on reading a field of undefined.
    expect((await app.api.post(`/api/days/${DATE}/sessions`)).status).toBe(400);
  });

  it('leaves a session as it is when patched with no body', async () => {
    const { id } = (await start()).body.session;
    const r = await app.api.patch(`/api/sessions/${id}`);
    expect(r.status).toBe(200);
    expect(r.body.session).toMatchObject({ label: 'Work', plannedSeconds: 1500 });
  });

  it('links only to a priority that exists on that day', async () => {
    const prio = await app.api.put(`/api/days/${DATE}/priorities`, { priorities: [{ text: 'Plan' }] });
    const uid: string = prio.body.priorities[0].uid;
    const shape = await start({ priorityUid: 'nope' });
    expect([shape.status, shape.body.error]).toEqual([400, 'priorityUid must be a priority id or null.']);
    const absent = await start({ priorityUid: 'abcdefabcdef' });
    expect([absent.status, absent.body.error]).toEqual([400, 'That priority is not on this day.']);
    const ok = await start({ priorityUid: uid.toUpperCase() });
    expect(ok.status).toBe(201);
    expect(ok.body.session.priorityUid).toBe(uid);
    // A uid from another day is "not on this day", and the refusal stores no day.
    await app.api.post(`/api/sessions/${ok.body.session.id}/finish`);
    expect((await app.api.post('/api/days/2026-09-02/sessions', { plannedSeconds: 600, priorityUid: uid })).status).toBe(400);
    expect(app.db.prepare(`SELECT date FROM days`).all()).toEqual([{ date: DATE }]);
  });

  it('patches the label and the link; planned time only while running', async () => {
    const prio = await app.api.put(`/api/days/${DATE}/priorities`, { priorities: [{ text: 'Plan' }] });
    const uid: string = prio.body.priorities[0].uid;
    const { id } = (await start()).body.session;
    const p = await app.api.patch(`/api/sessions/${id}`, {
      label: 'x'.repeat(LIMITS.sessionLabel + 100),
      priorityUid: uid,
      plannedSeconds: 600,
    });
    expect(p.status).toBe(200);
    expect(p.body.session).toMatchObject({
      label: 'x'.repeat(LIMITS.sessionLabel),
      priorityUid: uid,
      plannedSeconds: 600,
    });
    const shape = await app.api.patch(`/api/sessions/${id}`, { priorityUid: 'bad!' });
    expect([shape.status, shape.body.error]).toEqual([400, 'priorityUid must be a priority id or null.']);
    // A priority that exists on another day is refused, and the link stays.
    const other: string = (await app.api.put('/api/days/2026-09-02/priorities', { priorities: [{ text: 'Other' }] })).body.priorities[0].uid;
    const elsewhere = await app.api.patch(`/api/sessions/${id}`, { priorityUid: other });
    expect([elsewhere.status, elsewhere.body.error]).toEqual([400, 'That priority is not on this day.']);
    expect((await app.api.get(`/api/days/${DATE}`)).body.sessions[0].priorityUid).toBe(uid);
    expect((await app.api.patch(`/api/sessions/${id}`, { plannedSeconds: 10 })).status).toBe(400);
    // A wrong type is a 400 like everywhere else, not silently kept.
    const badLabel = await app.api.patch(`/api/sessions/${id}`, { label: 42 });
    expect(badLabel.status).toBe(400);
    expect(badLabel.body.error).toMatch(/label must be a string/);
    expect((await app.api.get(`/api/days/${DATE}`)).body.sessions[0].label).toBe('x'.repeat(LIMITS.sessionLabel));
    // Unlinking is explicit null; leaving it out keeps the link.
    expect((await app.api.patch(`/api/sessions/${id}`, { label: 'still' })).body.session.priorityUid).toBe(uid);
    expect((await app.api.patch(`/api/sessions/${id}`, { priorityUid: null })).body.session.priorityUid).toBeNull();
    await app.api.post(`/api/sessions/${id}/finish`);
    expect((await app.api.patch(`/api/sessions/${id}`, { plannedSeconds: 900 })).status).toBe(409);
    expect((await app.api.patch(`/api/sessions/${id}`, { label: 'after' })).status).toBe(200);
    expect((await app.api.patch('/api/sessions/999', { label: 'x' })).status).toBe(404);
  });

  it('finishes at the planned end when the timer expired unattended', async () => {
    const { id } = (await start({ plannedSeconds: 600 })).body.session;
    // Finished an hour later: the log shows the planned 10 min, not 60.
    at(HOUR_MS);
    const r = await app.api.post(`/api/sessions/${id}/finish`);
    expect(r.body.session).toMatchObject({ status: 'completed', durationSeconds: 600, endedAt: SEED_NOW + 600_000 });
    // Idempotent.
    at(HOUR_MS + 60_000);
    expect((await app.api.post(`/api/sessions/${id}/finish`)).body.session.endedAt).toBe(SEED_NOW + 600_000);
    expect((await app.api.get('/api/sessions/running')).body.session).toBeNull();
  });

  it('pauses and resumes, and logs only the time the clock was running', async () => {
    const { id } = (await start({ plannedSeconds: 1500 })).body.session;
    expect((await app.api.post(`/api/sessions/${id}/resume`)).body.session.pausedAt).toBeNull();
    at(60_000);
    const paused = await app.api.post(`/api/sessions/${id}/pause`);
    expect(paused.status).toBe(200);
    expect(paused.body.session).toMatchObject({ status: 'running', pausedSeconds: 0, pausedAt: SEED_NOW + 60_000 });
    // Still the one running timer, and a second pause changes nothing.
    expect((await app.api.get('/api/sessions/running')).body.session.pausedAt).toBe(SEED_NOW + 60_000);
    at(100_000);
    expect((await app.api.post(`/api/sessions/${id}/pause`)).body.session.pausedAt).toBe(SEED_NOW + 60_000);
    // Resuming banks the 90 s the pause lasted.
    at(150_000);
    const resumed = await app.api.post(`/api/sessions/${id}/resume`);
    expect(resumed.body.session).toMatchObject({ status: 'running', pausedAt: null, pausedSeconds: 90 });
    // Adjusting still works around a pause.
    expect((await app.api.patch(`/api/sessions/${id}`, { plannedSeconds: 600 })).body.session.plannedSeconds).toBe(600);
    // A second pause, then finish: the session ends when that pause began, and neither pause counts.
    at(300_000);
    await app.api.post(`/api/sessions/${id}/pause`);
    at(330_000);
    const done = await app.api.post(`/api/sessions/${id}/finish`);
    // 300 s from the start to the second pause, less the 90 s of the first.
    expect(done.body.session).toMatchObject({ status: 'completed', pausedSeconds: 90, pausedAt: null, endedAt: SEED_NOW + 300_000, durationSeconds: 210 });
    // Ended sessions can't be paused or resumed.
    expect((await app.api.post(`/api/sessions/${id}/pause`)).status).toBe(409);
    expect((await app.api.post(`/api/sessions/${id}/resume`)).status).toBe(409);
    expect((await app.api.post('/api/sessions/999/pause')).status).toBe(404);
    expect((await app.api.post('/api/sessions/999/resume')).status).toBe(404);
  });

  it('clamps a timer that ran out to its planned end, pushed out by the pauses it had', async () => {
    const { id } = (await start({ plannedSeconds: 600 })).body.session;
    // Two minutes of pauses push the planned 10 min out to 12; finished at 20.
    at(60_000);
    await app.api.post(`/api/sessions/${id}/pause`);
    at(180_000);
    await app.api.post(`/api/sessions/${id}/resume`);
    at(1_200_000);
    const r = await app.api.post(`/api/sessions/${id}/finish`);
    expect(r.body.session).toMatchObject({ durationSeconds: 600, startedAt: SEED_NOW, endedAt: SEED_NOW + 720_000 });
  });

  it('logs the planned length for a timer paused after it ran out, however long the pause', async () => {
    const { id } = (await start({ plannedSeconds: 600 })).body.session;
    // Two minutes of pauses, so the plan runs out at 12 min; paused again at 15 and finished at 20.
    at(60_000);
    await app.api.post(`/api/sessions/${id}/pause`);
    at(180_000);
    await app.api.post(`/api/sessions/${id}/resume`);
    at(900_000);
    await app.api.post(`/api/sessions/${id}/pause`);
    at(1_200_000);
    const r = await app.api.post(`/api/sessions/${id}/finish`);
    expect(r.body.session).toMatchObject({ status: 'completed', durationSeconds: 600, pausedAt: null, startedAt: SEED_NOW, endedAt: SEED_NOW + 720_000 });
  });

  it('cancels a paused timer and clears the pause', async () => {
    const { id } = (await start()).body.session;
    await app.api.post(`/api/sessions/${id}/pause`);
    const r = await app.api.post(`/api/sessions/${id}/cancel`);
    expect(r.body.session).toMatchObject({ status: 'cancelled', pausedAt: null });
  });

  it('logs the time past the planned end only when asked to', async () => {
    const { id } = (await start({ plannedSeconds: 600 })).body.session;
    at(HOUR_MS);
    expect((await app.api.post(`/api/sessions/${id}/finish`, { countOverrun: 'yes' })).status).toBe(400);
    // No body at all (curl) reads as "not asked", not a crash.
    const bare = await app.api.post(`/api/sessions/${id}/finish`);
    expect(bare.status).toBe(200);
    expect(bare.body.session.durationSeconds).toBe(600);
    // Finishing again with the flag changes nothing: it is already over.
    const r = await app.api.post(`/api/sessions/${id}/finish`, { countOverrun: true });
    expect(r.body.session.durationSeconds).toBe(600);
    // A fresh one, an hour in, asked to count the overrun.
    const again = (await start({ plannedSeconds: 600 })).body.session;
    at(2 * HOUR_MS);
    const counted = (await app.api.post(`/api/sessions/${again.id}/finish`, { countOverrun: true })).body.session;
    expect(counted).toMatchObject({ status: 'completed', durationSeconds: 3600 });
    // A paused session still ends where the pause began, overrun or not.
    const second = (await start({ plannedSeconds: 600 })).body.session;
    at(3 * HOUR_MS - 60_000);
    await app.api.post(`/api/sessions/${second.id}/pause`);
    at(3 * HOUR_MS);
    const done = await app.api.post(`/api/sessions/${second.id}/finish`, { countOverrun: true });
    expect(done.body.session).toMatchObject({ durationSeconds: 3540, endedAt: SEED_NOW + 3 * HOUR_MS - 60_000 });
  });

  it('finishes early with the elapsed time', async () => {
    const { id } = (await start({ plannedSeconds: 1500 })).body.session;
    at(90_000);
    const r = await app.api.post(`/api/sessions/${id}/finish`);
    expect(r.body.session).toMatchObject({ durationSeconds: 90, endedAt: SEED_NOW + 90_000 });
  });

  it('rounds the logged time to the nearest second', async () => {
    // 90.4 s logs 90, which rules out rounding up; 90.6 s logs 91, which rules out rounding down.
    const first = (await start()).body.session;
    at(90_400);
    expect((await app.api.post(`/api/sessions/${first.id}/finish`)).body.session.durationSeconds).toBe(90);
    at(200_000);
    const second = (await start()).body.session;
    at(290_600);
    expect((await app.api.post(`/api/sessions/${second.id}/finish`)).body.session.durationSeconds).toBe(91);
  });

  it('cancels, and a cancelled session leaves the day log', async () => {
    const { id } = (await start()).body.session;
    const r = await app.api.post(`/api/sessions/${id}/cancel`);
    expect(r.body.session.status).toBe('cancelled');
    expect((await app.api.get(`/api/days/${DATE}`)).body.sessions).toEqual([]);
    expect((await app.api.get('/api/sessions/running')).body.session).toBeNull();
    expect((await app.api.post(`/api/sessions/${id}/cancel`)).body.session.status).toBe('cancelled');
    expect((await app.api.post('/api/sessions/999/cancel')).status).toBe(404);
    // A finish that arrives after the cancel (the other device's timer ran out) changes nothing:
    // the client reads the status to know whether to celebrate.
    expect((await app.api.post(`/api/sessions/${id}/finish`)).body.session.status).toBe('cancelled');
  });

  it('deletes once', async () => {
    const { id } = (await start()).body.session;
    expect((await app.api.del(`/api/sessions/${id}`)).body).toEqual({ ok: true });
    expect((await app.api.del(`/api/sessions/${id}`)).status).toBe(404);
    expect((await app.api.get('/api/sessions/running')).body.session).toBeNull();
  });
});

describe('sessions are scoped to the signed-in user', () => {
  let app: TestApp;
  beforeEach(async () => {
    app = await startTestApp({ authMode: 'local' });
  });
  afterEach(() => app.close());

  it("hides one user's sessions from another", async () => {
    const { member, a, b } = await app.twoUsers();
    seedDatabase(app.db, { userId: member.id, today: SEED_TODAY, now: SEED_NOW, days: 1 });

    const started = await a.post(`/api/days/${DATE}/sessions`, { plannedSeconds: 900 });
    expect(started.status).toBe(201);
    const id = started.body.session.id;
    expect((await b.get('/api/sessions/running')).body.session).toBeNull();
    expect(await b.patch(`/api/sessions/${id}`, { label: 'mine now' })).toMatchObject({ status: 404, body: { error: 'Session not found.' } });
    expect((await b.post(`/api/sessions/${id}/pause`)).status).toBe(404);
    expect((await b.post(`/api/sessions/${id}/resume`)).status).toBe(404);
    expect((await b.post(`/api/sessions/${id}/finish`)).status).toBe(404);
    expect((await b.post(`/api/sessions/${id}/cancel`)).status).toBe(404);
    expect((await b.del(`/api/sessions/${id}`)).status).toBe(404);
    expect((await a.get('/api/sessions/running')).body.session).toMatchObject({ id, status: 'running' });
    expect((await b.get(`/api/days/${DATE}`)).body.sessions).toEqual([]);
    // B has their own seeded days; A does not see them.
    const range = '/api/days/range?from=2026-01-01&to=2026-12-31';
    expect((await b.get(range)).body.days).toHaveLength(2);
    expect((await a.get(range)).body.days.map((d: { date: string }) => d.date)).toEqual([DATE]);
    // B can start a timer while A's is running: the "one running timer" rule is per user.
    expect((await b.post(`/api/days/${DATE}/sessions`, { plannedSeconds: 900 })).status).toBe(201);
  });
});
