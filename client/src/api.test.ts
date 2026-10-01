// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from './api';
import { REQUEST_TIMEOUT_MS, UNAUTHENTICATED_EVENT } from './api';
import { ApiError } from './lib/apiError';
import { REQUEST_TIMEOUT } from './lib/copy';

/**
 * `request()` is plain `fetch`. The stub records each call and answers with whatever the test
 * queued: JSON by default, or a text body the way a proxy's error page arrives.
 */
const fetchMock = vi.fn<typeof fetch>();

function answer(status: number, body: unknown = {}, json = true): void {
  fetchMock.mockResolvedValueOnce(new Response(json ? JSON.stringify(body) : String(body), { status }));
}

function lastCall(): { path: string; init: RequestInit } {
  const [path, init] = fetchMock.mock.calls.at(-1)!;
  // `request()` always passes the path as a string.
  return { path: path as string, init: init! };
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

const DATE = '2026-09-28';

// Every call the client makes: the method, the path and the JSON it sends (none for a GET).
const ROUTES: [string, () => Promise<unknown>, string, string, unknown][] = [
  ['getAuth', () => api.getAuth(), 'GET', '/api/auth/me', undefined],
  [
    'setup',
    () => api.setup('ABCD-EFGH-JKLM', 'sam', 'secret-pass'),
    'POST',
    '/api/auth/setup',
    { setupCode: 'ABCD-EFGH-JKLM', username: 'sam', password: 'secret-pass' },
  ],
  ['login', () => api.login('sam', 'secret-pass'), 'POST', '/api/auth/login', { username: 'sam', password: 'secret-pass' }],
  ['logout', () => api.logout(), 'POST', '/api/auth/logout', undefined],
  [
    'changePassword',
    () => api.changePassword('old-pass-1', 'new-pass-1'),
    'POST',
    '/api/auth/password',
    { currentPassword: 'old-pass-1', newPassword: 'new-pass-1' },
  ],
  ['listUsers', () => api.listUsers(), 'GET', '/api/auth/users', undefined],
  ['addUser', () => api.addUser('kim', 'temp-pass-1'), 'POST', '/api/auth/users', { username: 'kim', password: 'temp-pass-1' }],
  ['deleteUser', () => api.deleteUser(7), 'DELETE', '/api/auth/users/7', undefined],
  ['getSettings', () => api.getSettings(), 'GET', '/api/settings', undefined],
  ['putSettings', () => api.putSettings({ sound: false }), 'PUT', '/api/settings', { sound: false }],
  ['resetSettings', () => api.resetSettings(), 'DELETE', '/api/settings', undefined],
  ['getDay', () => api.getDay(DATE), 'GET', `/api/days/${DATE}`, undefined],
  // Only the times go out: the server gives each row its position and kind from the order.
  [
    'putPunches',
    () =>
      api.putPunches(DATE, [
        { position: 0, kind: 'in', at: 5 },
        { position: 1, kind: 'out', at: null },
      ]),
    'PUT',
    `/api/days/${DATE}/punches`,
    { punches: [{ at: 5 }, { at: null }] },
  ],
  [
    'putPriorities',
    () => api.putPriorities(DATE, [{ position: 1, text: 'Report', done: false, uid: 'abcdef123456', addedAt: 1 }]),
    'PUT',
    `/api/days/${DATE}/priorities`,
    { priorities: [{ position: 1, text: 'Report', done: false, uid: 'abcdef123456', addedAt: 1 }] },
  ],
  ['putOvertime', () => api.putOvertime(DATE, true), 'PUT', `/api/days/${DATE}/overtime`, { approved: true }],
  ['putTarget', () => api.putTarget(DATE, null), 'PUT', `/api/days/${DATE}/target`, { workMinutes: null }],
  ['putRetro', () => api.putRetro(DATE, { note: 'why', done: true }), 'PUT', `/api/days/${DATE}/retro`, { note: 'why', done: true }],
  ['getRange', () => api.getRange('2026-09-01', DATE), 'GET', `/api/days/range?from=2026-09-01&to=${DATE}`, undefined],
  ['getPruneInfo', () => api.getPruneInfo('2025-09-28'), 'GET', '/api/days/prune?before=2025-09-28', undefined],
  ['pruneDays', () => api.pruneDays('2025-09-28'), 'POST', '/api/days/prune', { before: '2025-09-28' }],
  ['getRunning', () => api.getRunning(), 'GET', '/api/sessions/running', undefined],
  [
    'startSession',
    () => api.startSession(DATE, 1500, 'Report'),
    'POST',
    `/api/days/${DATE}/sessions`,
    { plannedSeconds: 1500, label: 'Report', priorityUid: null },
  ],
  ['patchSession', () => api.patchSession(3, { label: 'Renamed' }), 'PATCH', '/api/sessions/3', { label: 'Renamed' }],
  ['pauseSession', () => api.pauseSession(3), 'POST', '/api/sessions/3/pause', undefined],
  ['resumeSession', () => api.resumeSession(3), 'POST', '/api/sessions/3/resume', undefined],
  // A plain finish has no body, so the server clamps to the planned end.
  ['finishSession', () => api.finishSession(3), 'POST', '/api/sessions/3/finish', undefined],
  ['finishSession, counting the overrun', () => api.finishSession(3, true), 'POST', '/api/sessions/3/finish', { countOverrun: true }],
  ['cancelSession', () => api.cancelSession(3), 'POST', '/api/sessions/3/cancel', undefined],
  ['deleteSession', () => api.deleteSession(3), 'DELETE', '/api/sessions/3', undefined],
  ['startBreak', () => api.startBreak(DATE, 300), 'POST', `/api/days/${DATE}/breaks`, { plannedSeconds: 300 }],
  ['endBreak', () => api.endBreak(4), 'POST', '/api/breaks/4/end', undefined],
  ['deleteBreak', () => api.deleteBreak(4), 'DELETE', '/api/breaks/4', undefined],
];

describe('routes', () => {
  it.each(ROUTES)('%s', async (_name, call, method, path, body) => {
    answer(200, { ok: true });
    await expect(call()).resolves.toEqual({ ok: true });
    const sent = lastCall();
    expect(sent.path).toBe(path);
    expect(sent.init.method).toBe(method);
    expect(sent.init.credentials).toBe('same-origin');
    expect(sent.init.signal).toBeDefined();
    if (body === undefined) {
      expect(sent.init.body).toBeUndefined();
      expect(sent.init.headers).toBeUndefined();
    } else {
      expect(JSON.parse(sent.init.body as string)).toEqual(body);
      expect(sent.init.headers).toEqual({ 'content-type': 'application/json' });
    }
  });
});

describe('failures', () => {
  it("throws an ApiError with the server's message, status and body", async () => {
    const body = { error: 'A timer is already running.', session: { id: 9 } };
    answer(409, body);
    const err = await api.startSession(DATE, 1500, '').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, message: 'A timer is already running.', body });
  });

  it('names the status when the body is not JSON, such as a proxy error page', async () => {
    answer(502, '<html>Bad gateway</html>', false);
    await expect(api.getDay(DATE)).rejects.toMatchObject({ status: 502, message: 'Request failed (502)', body: null });
  });

  it('refuses a 200 whose body is not JSON, such as a sign-in page from a proxy in front', async () => {
    answer(200, '<html>Sign in</html>', false);
    await expect(api.getDay(DATE)).rejects.toMatchObject({ status: 200, message: 'Unreadable answer (200)', body: null });
  });

  it('announces a lost session on a 401, but not for a wrong password at sign-in or from /api/auth/me itself', async () => {
    const lost = vi.fn();
    window.addEventListener(UNAUTHENTICATED_EVENT, lost);
    try {
      answer(401, { error: 'Not signed in.' });
      await expect(api.getDay(DATE)).rejects.toMatchObject({ status: 401 });
      expect(lost).toHaveBeenCalledTimes(1);

      answer(401, { error: 'Incorrect username or password.' });
      await expect(api.login('sam', 'wrong-pass')).rejects.toMatchObject({ status: 401, message: 'Incorrect username or password.' });
      expect(lost).toHaveBeenCalledTimes(1);

      // A proxy's own sign-in in front of the app; announcing it would ask /me again at once.
      answer(401, { error: 'Unauthorized' });
      await expect(api.getAuth()).rejects.toMatchObject({ status: 401 });
      expect(lost).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(UNAUTHENTICATED_EVENT, lost);
    }
  });

  it('gives up after 30 s, waiting for the answer or its body, and says the server did not answer', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    fetchMock.mockRejectedValueOnce(new DOMException('signal timed out', 'TimeoutError'));
    const err = await api.getDay(DATE).catch((e: unknown) => e);
    expect(timeout).toHaveBeenCalledWith(REQUEST_TIMEOUT_MS);
    expect(err).not.toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ message: REQUEST_TIMEOUT });

    // The headers came, the body didn't.
    const stalled = { ok: true, status: 200, json: () => Promise.reject(new DOMException('signal timed out', 'TimeoutError')) };
    fetchMock.mockResolvedValueOnce(stalled as unknown as Response);
    await expect(api.putOvertime(DATE, true)).rejects.toThrow(REQUEST_TIMEOUT);
  });

  it('leaves a network failure as the error fetch threw', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(api.getRunning()).rejects.toThrow('Failed to fetch');
  });
});
