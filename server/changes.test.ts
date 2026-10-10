import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_STREAMS } from './changes.js';
import { startTestApp, type ApiResponse, type TestApp } from './dev/harness.js';
import { REVISION_HEADER } from '../shared/api.js';

let app: TestApp;
afterEach(() => app.close());

const event = (res: ApiResponse) => `data: ${res.headers.get(REVISION_HEADER)}`;

describe('GET /api/changes', () => {
  it('opens an event stream that names the revision at once, unbuffered and uncached', async () => {
    app = await startTestApp();
    await app.api.put('/api/settings', {});
    const stream = await app.api.stream('/api/changes');
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toBe('text/event-stream');
    expect(stream.headers.get('x-accel-buffering')).toBe('no');
    expect(stream.headers.get('cache-control')).toBe('no-store');
    expect(await stream.next()).toBe(event(await app.api.get('/api/settings')));
  });

  it("sends each write's revision to every stream the user has open once it has answered, a refusal's included; a read sends nothing", async () => {
    app = await startTestApp();
    const phone = await app.api.stream('/api/changes');
    const laptop = await app.api.stream('/api/changes');
    expect([await phone.next(), await laptop.next()]).toEqual(['data: 0', 'data: 0']);
    await app.api.get('/api/settings');
    const saved = await app.api.put('/api/settings', {});
    expect([await phone.next(), await laptop.next()]).toEqual([event(saved), event(saved)]);
    const refused = await app.api.put('/api/days/not-a-date/priorities', { priorities: [] });
    expect(refused.status).toBe(400);
    expect(await phone.next()).toBe(event(refused));
  });

  it("never tells one user of another's writes, and needs a session", async () => {
    app = await startTestApp({ authMode: 'local' });
    const anonymous = await app.api.stream('/api/changes');
    expect(anonymous.status).toBe(401);
    const { a, b } = await app.twoUsers();
    const mine = await a.stream('/api/changes');
    expect(await mine.next()).toBe('data: 0');
    await a.put('/api/settings', {});
    expect(await mine.next()).toBe('data: 1');
    // b's own count is at 1 too, so a's stream must skip it to hear 2.
    await b.put('/api/settings', {});
    await a.put('/api/settings', {});
    expect(await mine.next()).toBe('data: 2');
  });

  it('refuses a stream past MAX_STREAMS with a 429, and takes one again once a stream closes', async () => {
    app = await startTestApp();
    const open = await Promise.all(Array.from({ length: MAX_STREAMS }, () => app.api.stream('/api/changes')));
    expect(open.map((s) => s.status)).toEqual(Array(MAX_STREAMS).fill(200));
    const refused = await app.api.stream('/api/changes');
    expect(refused.status).toBe(429);
    open[0]!.close();
    await vi.waitFor(async () => {
      const again = await app.api.stream('/api/changes');
      again.close();
      expect(again.status).toBe(200);
    });
  });

  it('pings every stream with a comment, and end() ends them and forgets them', async () => {
    app = await startTestApp();
    const stream = await app.api.stream('/api/changes');
    await stream.next();
    app.changes.ping();
    expect(await stream.next()).toBe(': ping');
    app.changes.end();
    // A write to an ended answer would be an uncaught error.
    expect(() => app.changes.ping()).not.toThrow();
    await expect(stream.next()).rejects.toThrow('stream ended');
  });
});
