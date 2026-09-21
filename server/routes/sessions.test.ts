import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SEED_TODAY, startTestApp, type TestApp } from '../dev/harness.js';
import { LOCAL_USERS, ensureLocalUsers, seedDatabase } from '../dev/seed.js';
import { LIMITS } from '../../shared/api.js';

const DATE = '2026-09-01';

describe('sessions', () => {
  let app: TestApp;
  beforeEach(async () => {
    app = await startTestApp();
  });
  afterEach(() => app.close());

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

  it('validates planned time and the date', async () => {
    expect((await start({ plannedSeconds: 59 })).status).toBe(400);
    expect((await start({ plannedSeconds: 8 * 3600 + 1 })).status).toBe(400);
    expect((await start({ plannedSeconds: 90.5 })).status).toBe(400);
    expect((await app.api.post('/api/days/nope/sessions', { plannedSeconds: 1500 })).status).toBe(400);
  });

  it('links only to a priority that exists on that day', async () => {
    const prio = await app.api.put(`/api/days/${DATE}/priorities`, { priorities: [{ text: 'Plan' }] });
    const uid: string = prio.body.priorities[0].uid;
    expect((await start({ priorityUid: 'nope' })).status).toBe(400);
    expect((await start({ priorityUid: 'abcdefabcdef' })).status).toBe(400);
    const ok = await start({ priorityUid: uid.toUpperCase() });
    expect(ok.status).toBe(201);
    expect(ok.body.session.priorityUid).toBe(uid);
    // A uid from another day is "not on this day".
    await app.api.post(`/api/sessions/${ok.body.session.id}/finish`);
    expect((await app.api.post('/api/days/2026-09-02/sessions', { plannedSeconds: 600, priorityUid: uid })).status).toBe(400);
  });

  it('patches label, notes and the link; planned time only while running', async () => {
    const prio = await app.api.put(`/api/days/${DATE}/priorities`, { priorities: [{ text: 'Plan' }] });
    const uid: string = prio.body.priorities[0].uid;
    const { id } = (await start()).body.session;
    const p = await app.api.patch(`/api/sessions/${id}`, {
      label: 'x'.repeat(LIMITS.sessionLabel + 100),
      notes: 'y'.repeat(LIMITS.sessionNotes + 100),
      priorityUid: uid,
      plannedSeconds: 600,
    });
    expect(p.status).toBe(200);
    expect(p.body.session).toMatchObject({
      label: 'x'.repeat(LIMITS.sessionLabel),
      notes: 'y'.repeat(LIMITS.sessionNotes),
      priorityUid: uid,
      plannedSeconds: 600,
    });
    expect((await app.api.patch(`/api/sessions/${id}`, { priorityUid: 'bad!' })).status).toBe(400);
    expect((await app.api.patch(`/api/sessions/${id}`, { plannedSeconds: 10 })).status).toBe(400);
    // A wrong type is a 400 like everywhere else, not silently kept.
    const badLabel = await app.api.patch(`/api/sessions/${id}`, { label: 42 });
    expect(badLabel.status).toBe(400);
    expect(badLabel.body.error).toMatch(/label must be a string/);
    expect((await app.api.patch(`/api/sessions/${id}`, { notes: ['x'] })).status).toBe(400);
    expect((await app.api.get(`/api/days/${DATE}`)).body.sessions[0].label).toBe('x'.repeat(LIMITS.sessionLabel));
    // Unlinking is explicit null; leaving it out keeps the link.
    expect((await app.api.patch(`/api/sessions/${id}`, { notes: 'still' })).body.session.priorityUid).toBe(uid);
    expect((await app.api.patch(`/api/sessions/${id}`, { priorityUid: null })).body.session.priorityUid).toBeNull();
    await app.api.post(`/api/sessions/${id}/finish`);
    expect((await app.api.patch(`/api/sessions/${id}`, { plannedSeconds: 900 })).status).toBe(409);
    expect((await app.api.patch(`/api/sessions/${id}`, { label: 'after' })).status).toBe(200);
    expect((await app.api.patch('/api/sessions/999', { label: 'x' })).status).toBe(404);
  });

  it('finishes at the planned end when the timer expired unattended', async () => {
    const { id } = (await start({ plannedSeconds: 600 })).body.session;
    // Pretend it started an hour ago: the log must show the planned 10 min, not 60.
    app.db.prepare(`UPDATE sessions SET started_at = ? WHERE id = ?`).run(Date.now() - 3_600_000, id);
    const r = await app.api.post(`/api/sessions/${id}/finish`);
    expect(r.body.session.status).toBe('completed');
    expect(r.body.session.durationSeconds).toBe(600);
    // Idempotent.
    expect((await app.api.post(`/api/sessions/${id}/finish`)).body.session.endedAt).toBe(r.body.session.endedAt);
    expect((await app.api.get('/api/sessions/running')).body.session).toBeNull();
  });

  it('finishes early with the elapsed time', async () => {
    const { id } = (await start({ plannedSeconds: 1500 })).body.session;
    const r = await app.api.post(`/api/sessions/${id}/finish`);
    expect(r.body.session.durationSeconds).toBeLessThan(5);
  });

  it('cancels, and a cancelled session leaves the day log', async () => {
    const { id } = (await start()).body.session;
    const r = await app.api.post(`/api/sessions/${id}/cancel`);
    expect(r.body.session.status).toBe('cancelled');
    expect((await app.api.get(`/api/days/${DATE}`)).body.sessions).toEqual([]);
    expect((await app.api.get('/api/sessions/running')).body.session).toBeNull();
    expect((await app.api.post(`/api/sessions/${id}/cancel`)).body.session.status).toBe('cancelled');
    expect((await app.api.post('/api/sessions/999/cancel')).status).toBe(404);
  });

  it('deletes once', async () => {
    const { id } = (await start()).body.session;
    expect((await app.api.del(`/api/sessions/${id}`)).body).toEqual({ ok: true });
    expect((await app.api.del(`/api/sessions/${id}`)).status).toBe(404);
    expect((await app.api.get('/api/sessions/running')).body.session).toBeNull();
  });

  it('starts a timer on a seeded today next to the seeded history', async () => {
    await app.close();
    app = await startTestApp({ seed: { running: false } });
    const today = app.seeded!.days.at(-1)!;
    const r = await app.api.post(`/api/days/${SEED_TODAY}/sessions`, { plannedSeconds: 1500, priorityUid: today.priorities[1]!.uid });
    expect(r.status).toBe(201);
    expect((await app.api.get(`/api/days/${SEED_TODAY}`)).body.sessions).toHaveLength(today.sessions.length + 1);
  });
});

describe('sessions are scoped to the signed-in user', () => {
  let app: TestApp;
  beforeEach(async () => {
    app = await startTestApp({ authMode: 'local' });
  });
  afterEach(() => app.close());

  it("hides one user's sessions from another", async () => {
    const { admin, member } = await ensureLocalUsers(app.db);
    const a = app.client();
    const b = app.client();
    expect((await a.post('/api/auth/login', { username: LOCAL_USERS.admin, password: LOCAL_USERS.password })).status).toBe(200);
    expect((await b.post('/api/auth/login', { username: LOCAL_USERS.member, password: LOCAL_USERS.password })).status).toBe(200);
    seedDatabase(app.db, { userId: member.id, today: SEED_TODAY, now: Date.now(), days: 1 });
    expect(admin.id).not.toBe(member.id);

    const started = await a.post(`/api/days/${DATE}/sessions`, { plannedSeconds: 900 });
    expect(started.status).toBe(201);
    const id = started.body.session.id;
    expect((await b.get('/api/sessions/running')).body.session).toBeNull();
    expect((await b.patch(`/api/sessions/${id}`, { label: 'mine now' })).status).toBe(404);
    expect((await b.post(`/api/sessions/${id}/finish`)).status).toBe(404);
    expect((await b.del(`/api/sessions/${id}`)).status).toBe(404);
    expect((await b.get(`/api/days/${DATE}`)).body.sessions).toEqual([]);
    // B has their own seeded day; A does not see it.
    expect((await b.get('/api/days')).body.days).toHaveLength(2);
    expect((await a.get('/api/days')).body.days.map((d: { date: string }) => d.date)).toEqual([DATE]);
    // B can start a timer while A's is running: the "one running timer" rule is per user.
    expect((await b.post(`/api/days/${DATE}/sessions`, { plannedSeconds: 900 })).status).toBe(201);
  });
});
