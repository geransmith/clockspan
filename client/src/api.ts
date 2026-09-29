import type {
  AuthInfo,
  BreakEndResponse,
  BreakResponse,
  Day,
  LogoutResponse,
  OkResponse,
  OvertimeResponse,
  PrioritiesResponse,
  Priority,
  PruneInfo,
  PruneResult,
  Punch,
  PunchesResponse,
  RangeResponse,
  RetroResponse,
  RunningResponse,
  SessionResponse,
  Settings,
  TargetResponse,
  UserResponse,
  UsersResponse,
} from './types';
import { ApiError } from './lib/apiError';
import { REQUEST_TIMEOUT } from './lib/copy';

export const UNAUTHENTICATED_EVENT = 'focus:unauthenticated';

/**
 * How long a request may take, answer included. `fetch` has no limit of its own: one that never
 * answers (a phone changing networks mid-request) would hold the day's save queue and its
 * refreshes until the browser gave up minutes later, with nothing on screen meanwhile.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

const timedOut = (err: unknown): boolean => (err as { name?: unknown } | null)?.name === 'TimeoutError';

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw timedOut(err) ? new Error(REQUEST_TIMEOUT) : err;
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch (err) {
    if (timedOut(err)) throw new Error(REQUEST_TIMEOUT);
    // Every API answer is JSON, so a body that isn't is a page from something in between: a
    // proxy's error page (the generic message below), or a forward-auth proxy's sign-in page,
    // which comes as a 200 once its session runs out and must not pass for an empty answer.
    if (res.ok) throw new ApiError(res.status, `Unreadable answer (${res.status})`, null);
  }
  if (!res.ok) {
    const message = (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
    // The login route answers 401 for a wrong password; that is not a lost session.
    if (res.status === 401 && path !== '/api/auth/login') window.dispatchEvent(new Event(UNAUTHENTICATED_EVENT));
    throw new ApiError(res.status, message, data);
  }
  return data as T;
}

// ----- auth -----
export const getAuth = () => request<AuthInfo>('GET', '/api/auth/me');
export const setup = (setupCode: string, username: string, password: string) =>
  request<UserResponse>('POST', '/api/auth/setup', { setupCode, username, password });
export const login = (username: string, password: string) => request<UserResponse>('POST', '/api/auth/login', { username, password });
export const logout = () => request<LogoutResponse>('POST', '/api/auth/logout');
export const changePassword = (currentPassword: string, newPassword: string) =>
  request<OkResponse>('POST', '/api/auth/password', { currentPassword, newPassword });
export const listUsers = () => request<UsersResponse>('GET', '/api/auth/users');
export const addUser = (username: string, password: string) => request<UserResponse>('POST', '/api/auth/users', { username, password });
export const deleteUser = (id: number) => request<OkResponse>('DELETE', `/api/auth/users/${id}`);

// ----- settings -----
export const getSettings = () => request<Settings>('GET', '/api/settings');
export const putSettings = (patch: Partial<Settings>) => request<Settings>('PUT', '/api/settings', patch);
export const resetSettings = () => request<Settings>('DELETE', '/api/settings');

// ----- days -----
export const getDay = (date: string) => request<Day>('GET', `/api/days/${date}`);
export const putPunches = (date: string, punches: Punch[]) =>
  request<PunchesResponse>('PUT', `/api/days/${date}/punches`, { punches: punches.map((p) => ({ at: p.at })) });
export const putPriorities = (date: string, priorities: Priority[]) => request<PrioritiesResponse>('PUT', `/api/days/${date}/priorities`, { priorities });
export const putOvertime = (date: string, approved: boolean) => request<OvertimeResponse>('PUT', `/api/days/${date}/overtime`, { approved });
export const putTarget = (date: string, workMinutes: number | null) => request<TargetResponse>('PUT', `/api/days/${date}/target`, { workMinutes });
export const putRetro = (date: string, patch: { note?: string; done?: boolean }) => request<RetroResponse>('PUT', `/api/days/${date}/retro`, patch);
export const getRange = (from: string, to: string) => request<RangeResponse>('GET', `/api/days/range?from=${from}&to=${to}`);
export const getPruneInfo = (before: string) => request<PruneInfo>('GET', `/api/days/prune?before=${before}`);
export const pruneDays = (before: string) => request<PruneResult>('POST', '/api/days/prune', { before });

// ----- sessions -----
export const getRunning = () => request<RunningResponse>('GET', '/api/sessions/running');
export const startSession = (date: string, plannedSeconds: number, label: string, priorityUid: string | null = null) =>
  request<SessionResponse>('POST', `/api/days/${date}/sessions`, { plannedSeconds, label, priorityUid });
export const patchSession = (id: number, patch: { plannedSeconds?: number; label?: string; priorityUid?: string | null }) =>
  request<SessionResponse>('PATCH', `/api/sessions/${id}`, patch);
export const pauseSession = (id: number) => request<SessionResponse>('POST', `/api/sessions/${id}/pause`);
export const resumeSession = (id: number) => request<SessionResponse>('POST', `/api/sessions/${id}/resume`);
export const finishSession = (id: number, countOverrun = false) =>
  request<SessionResponse>('POST', `/api/sessions/${id}/finish`, countOverrun ? { countOverrun } : undefined);
export const cancelSession = (id: number) => request<SessionResponse>('POST', `/api/sessions/${id}/cancel`);
export const deleteSession = (id: number) => request<OkResponse>('DELETE', `/api/sessions/${id}`);

// ----- breaks -----
export const startBreak = (date: string, plannedSeconds: number) => request<BreakResponse>('POST', `/api/days/${date}/breaks`, { plannedSeconds });
export const endBreak = (id: number) => request<BreakEndResponse>('POST', `/api/breaks/${id}/end`);
export const deleteBreak = (id: number) => request<OkResponse>('DELETE', `/api/breaks/${id}`);
