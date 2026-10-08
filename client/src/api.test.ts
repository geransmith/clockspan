// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from './api';
import { REQUEST_TIMEOUT_MS, UNAUTHENTICATED_EVENT } from './api';
import { ApiError } from './lib/apiError';
import { alert, dismissByTag, getBanners, subscribeBanners } from './lib/alerts';
import { REQUEST_TIMEOUT, UPDATED } from './lib/copy';
import { VERSION_HEADER } from '../../shared/api.js';

// The real alerts, watched, so a test can see what a banner was raised with as well as the banner.
vi.mock('./lib/alerts', { spy: true });

/**
 * `request()` is plain `fetch`. The stub records each call and answers with whatever the test
 * queued: JSON by default, or a text body the way a proxy's error page arrives, with the
 * headers given.
 */
const fetchMock = vi.fn<typeof fetch>();

function answer(status: number, body: unknown = {}, json = true, headers?: HeadersInit): void {
  fetchMock.mockResolvedValueOnce(new Response(json ? JSON.stringify(body) : String(body), { status, headers }));
}

/** A data answer from a server on `version`. */
function answerFrom(version: string, status = 200, body: unknown = {}): void {
  answer(status, body, true, { [VERSION_HEADER]: version });
}

function lastCall(): { path: string; init: RequestInit } {
  const [path, init] = fetchMock.mock.calls.at(-1)!;
  // `request()` always passes the path as a string.
  return { path: path as string, init: init! };
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

const DATE = '2026-09-28';
const NO_LINKS = { cardUid: null, recurringUid: null, categoryUid: null };
const REPORT_LINKS = { cardUid: 'card00000001', recurringUid: null, categoryUid: 'cafe00000001' };

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
  // With the list it was built on, so the server can keep another device's changes, and every row's links.
  [
    'putPriorities',
    () =>
      api.putPriorities(DATE, [{ position: 1, text: 'Report', done: false, uid: 'abcdef123456', addedAt: 1, ...REPORT_LINKS }], {
        base: [{ position: 1, text: '', done: false, uid: null, addedAt: null, ...NO_LINKS }],
      }),
    'PUT',
    `/api/days/${DATE}/priorities`,
    {
      priorities: [{ position: 1, text: 'Report', done: false, uid: 'abcdef123456', addedAt: 1, ...REPORT_LINKS }],
      base: [{ position: 1, text: '', done: false, uid: null, addedAt: null, ...NO_LINKS }],
    },
  ],
  // The board's flags: make cards for rows without one, and the cards a board action handled.
  [
    'putPriorities, from the board',
    () =>
      api.putPriorities(DATE, [{ position: 1, text: 'Report', done: true, uid: 'abcdef123456', addedAt: 1, ...REPORT_LINKS }], {
        cards: true,
        touched: ['card00000001'],
      }),
    'PUT',
    `/api/days/${DATE}/priorities`,
    {
      priorities: [{ position: 1, text: 'Report', done: true, uid: 'abcdef123456', addedAt: 1, ...REPORT_LINKS }],
      cards: true,
      touched: ['card00000001'],
    },
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
    () => api.startSession(DATE, 1500, 'Report', null),
    'POST',
    `/api/days/${DATE}/sessions`,
    { plannedSeconds: 1500, label: 'Report', priorityUid: null },
  ],
  ['patchSession', () => api.patchSession(3, { label: 'Renamed' }), 'PATCH', '/api/sessions/3', { label: 'Renamed' }],
  ['patchSession, picking a category', () => api.patchSession(3, { categoryUid: 'cat000000001' }), 'PATCH', '/api/sessions/3', { categoryUid: 'cat000000001' }],
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
  ['getBoard', () => api.getBoard(), 'GET', '/api/board', undefined],
  [
    'addCard',
    () => api.addCard({ uid: 'card00000002', title: 'Write the KB', categoryUid: 'cat000000001', lane: 'later', before: 'card00000001' }),
    'POST',
    '/api/board/cards',
    { uid: 'card00000002', title: 'Write the KB', categoryUid: 'cat000000001', lane: 'later', before: 'card00000001' },
  ],
  [
    'patchCard',
    () => api.patchCard('card00000002', { today: DATE, categoryUid: null, lane: 'next', before: null }),
    'PATCH',
    '/api/board/cards/card00000002',
    { today: DATE, categoryUid: null, lane: 'next', before: null },
  ],
  ['deleteCard', () => api.deleteCard('card00000002'), 'DELETE', '/api/board/cards/card00000002', undefined],
  [
    'addCategory',
    () => api.addCategory({ uid: 'cat000000001', name: 'Tickets', color: 'blue' }),
    'POST',
    '/api/board/categories',
    { uid: 'cat000000001', name: 'Tickets', color: 'blue' },
  ],
  [
    'patchCategory',
    () => api.patchCategory('cat000000001', { name: 'Support tickets', color: 'teal' }),
    'PATCH',
    '/api/board/categories/cat000000001',
    { name: 'Support tickets', color: 'teal' },
  ],
  ['deleteCategory', () => api.deleteCategory('cat000000001'), 'DELETE', '/api/board/categories/cat000000001', undefined],
  [
    'addRecurring',
    () => api.addRecurring({ uid: 'rcur00000001', title: 'Monitor the queue', categoryUid: 'cat000000001', weekdays: [1, 2, 3, 4, 5] }),
    'POST',
    '/api/board/recurring',
    { uid: 'rcur00000001', title: 'Monitor the queue', categoryUid: 'cat000000001', weekdays: [1, 2, 3, 4, 5] },
  ],
  [
    'patchRecurring',
    () => api.patchRecurring('rcur00000001', { title: 'Watch the queue', categoryUid: null, weekdays: [1, 3, 5] }),
    'PATCH',
    '/api/board/recurring/rcur00000001',
    { title: 'Watch the queue', categoryUid: null, weekdays: [1, 3, 5] },
  ],
  ['deleteRecurring', () => api.deleteRecurring('rcur00000001'), 'DELETE', '/api/board/recurring/rcur00000001', undefined],
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
    const err = await api.startSession(DATE, 1500, '', null).catch((e: unknown) => e);
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
    const stalled = { ok: true, status: 200, headers: new Headers(), json: () => Promise.reject(new DOMException('signal timed out', 'TimeoutError')) };
    fetchMock.mockResolvedValueOnce(stalled as unknown as Response);
    await expect(api.putOvertime(DATE, true)).rejects.toThrow(REQUEST_TIMEOUT);
  });

  it('leaves a network failure as the error fetch threw', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(api.getRunning()).rejects.toThrow('Failed to fetch');
  });
});

describe('an update while the page is open', () => {
  // The banner is raised once per version the server names, for the life of the page, so each
  // case names a version of its own.
  const updated = () => getBanners().filter((b) => b.tag === 'updated');
  afterEach(() => dismissByTag('updated'));

  it('says nothing while the server names this build, or names nothing: the auth routes, the health check, a page from a proxy', async () => {
    const raised = vi.fn();
    const off = subscribeBanners(raised);
    try {
      answerFrom(__APP_VERSION__);
      await api.getSettings();
      answer(200, { mode: 'none' });
      await api.getAuth();
      expect(raised).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });

  it('raises one quiet banner that stays, and not again for that version once closed', async () => {
    vi.useFakeTimers();
    const raised = vi.fn();
    const off = subscribeBanners(raised);
    try {
      answerFrom('9.0.0');
      await api.getSettings();
      answerFrom('9.0.0');
      await api.getDay(DATE);
      expect(raised).toHaveBeenCalledTimes(1);
      expect(updated()).toEqual([
        expect.objectContaining({ title: UPDATED.title, body: UPDATED.body, tone: 'info', action: { label: UPDATED.reload, run: expect.any(Function) } }),
      ]);
      // Quiet: no chime, no notification, and kept until closed.
      expect(alert).toHaveBeenCalledTimes(1);
      const [raisedWith] = vi.mocked(alert).mock.calls[0]!;
      expect(raisedWith).toMatchObject({ sound: false, notifications: false, sticky: true });
      expect(raisedWith).not.toHaveProperty('chime');
      vi.advanceTimersByTime(60_000);
      expect(updated()).toHaveLength(1);

      dismissByTag('updated');
      answerFrom('9.0.0');
      await api.getSettings();
      expect(updated()).toEqual([]);

      // The server moved again: that is news.
      answerFrom('9.0.1');
      await api.getSettings();
      expect(updated()).toHaveLength(1);
    } finally {
      off();
      vi.useRealTimers();
    }
  });

  it('raises it on a refusal too: a save the new server turns down may be the first answer to bring the news', async () => {
    answerFrom('9.1.0', 409, { error: 'Refused.' });
    await expect(api.putSettings({ sound: false })).rejects.toMatchObject({ status: 409 });
    expect(updated()).toHaveLength(1);
  });

  it('reloads the page from its button', async () => {
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    answerFrom('9.2.0');
    await api.getRunning();
    updated()[0]!.action!.run();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
