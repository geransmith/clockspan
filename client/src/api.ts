import type { AuthInfo, Day, DaySummary, Priority, PruneInfo, PublicUser, Punch, Session, Settings } from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

export const UNAUTHENTICATED_EVENT = 'focus:unauthenticated';

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 204) return undefined as T;
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON error bodies (e.g. a proxy page) fall through to the generic message.
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
export const setup = (username: string, password: string) => request<{ user: PublicUser }>('POST', '/api/auth/setup', { username, password });
export const login = (username: string, password: string) => request<{ user: PublicUser }>('POST', '/api/auth/login', { username, password });
export const logout = () => request<{ ok: true; redirect?: string | null }>('POST', '/api/auth/logout');
export const changePassword = (currentPassword: string, newPassword: string) =>
  request<{ ok: true }>('POST', '/api/auth/password', { currentPassword, newPassword });
export const listUsers = () => request<{ users: PublicUser[] }>('GET', '/api/auth/users');
export const addUser = (username: string, password: string) => request<{ user: PublicUser }>('POST', '/api/auth/users', { username, password });
export const deleteUser = (id: number) => request<{ ok: true }>('DELETE', `/api/auth/users/${id}`);

// ----- settings -----
export const getSettings = () => request<Settings>('GET', '/api/settings');
export const putSettings = (patch: Partial<Settings>) => request<Settings>('PUT', '/api/settings', patch);
export const resetSettings = () => request<Settings>('DELETE', '/api/settings');

// ----- days -----
export const listDays = (limit = 60) => request<{ days: DaySummary[] }>('GET', `/api/days?limit=${limit}`);
export const getDay = (date: string) => request<Day>('GET', `/api/days/${date}`);
export const putPunches = (date: string, punches: Punch[]) =>
  request<{ punches: Punch[] }>('PUT', `/api/days/${date}/punches`, { punches: punches.map((p) => ({ at: p.at })) });
export const putPriorities = (date: string, priorities: Priority[]) =>
  request<{ priorities: Priority[] }>('PUT', `/api/days/${date}/priorities`, { priorities });
export const putOvertime = (date: string, approved: boolean) => request<{ overtimeApproved: boolean }>('PUT', `/api/days/${date}/overtime`, { approved });
export const putRetro = (date: string, patch: { note?: string; done?: boolean }) =>
  request<{ retroNote: string; retroAt: number | null }>('PUT', `/api/days/${date}/retro`, patch);
export const getRange = (from: string, to: string) => request<{ days: Day[] }>('GET', `/api/days/range?from=${from}&to=${to}`);
export const getPruneInfo = (before: string) => request<PruneInfo>('GET', `/api/days/prune?before=${before}`);
export const pruneDays = (before: string) => request<{ deleted: number }>('POST', '/api/days/prune', { before });

// ----- sessions -----
export const getRunning = () => request<{ session: Session | null }>('GET', '/api/sessions/running');
export const startSession = (date: string, plannedSeconds: number, label: string, priorityUid: string | null = null) =>
  request<{ session: Session }>('POST', `/api/days/${date}/sessions`, { plannedSeconds, label, priorityUid });
export const patchSession = (id: number, patch: { plannedSeconds?: number; label?: string; notes?: string; priorityUid?: string | null }) =>
  request<{ session: Session }>('PATCH', `/api/sessions/${id}`, patch);
export const finishSession = (id: number) => request<{ session: Session }>('POST', `/api/sessions/${id}/finish`);
export const cancelSession = (id: number) => request<{ session: Session }>('POST', `/api/sessions/${id}/cancel`);
export const deleteSession = (id: number) => request<{ ok: true }>('DELETE', `/api/sessions/${id}`);
