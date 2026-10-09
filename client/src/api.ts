import type {
  AuthInfo,
  Board,
  BoardCard,
  BreakEndResponse,
  BreakResponse,
  Category,
  Day,
  ErrorResponse,
  LogoutResponse,
  OkResponse,
  OpenLane,
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
  Session,
  SessionResponse,
  Settings,
  TargetResponse,
  UserResponse,
  UsersResponse,
} from './types';
import { VERSION_HEADER } from '../../shared/api.js';
import { alert } from './lib/alerts';
import { ApiError } from './lib/apiError';
import { REQUEST_FAILED, REQUEST_TIMEOUT, UNREADABLE_ANSWER, UPDATED } from './lib/copy';

export const UNAUTHENTICATED_EVENT = 'focus:unauthenticated';

/**
 * How long a request may take, answer included. `fetch` has no limit of its own: one that never
 * answers (a phone changing networks mid-request) would hold whatever waits behind it until the
 * browser gave up minutes later, with nothing on screen meanwhile: the writes queued after it in
 * its store (the day's, the timer's, the settings' or the board's), or the later refreshes of a day
 * whose read is still out.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

const timedOut = (err: unknown): boolean => err instanceof DOMException && err.name === 'TimeoutError';

/** The server version the update banner was raised for, so a closed banner stays closed until the server moves again. */
let announced: string | null = null;

/**
 * Every signed-in data answer names the server's version (`VERSION_HEADER`). One that isn't
 * this build's means the page was loaded before an update, and its saves may not suit the new
 * server, so it asks for a reload: one quiet banner, kept until closed, raised once per version
 * heard rather than on every answer. A refusal counts too, since a save the new server turns
 * down is often the first answer to bring the news.
 */
function noticeVersion(version: string | null): void {
  if (version === null || version === __APP_VERSION__ || version === announced) return;
  announced = version;
  alert({
    title: UPDATED.title,
    body: UPDATED.body,
    tone: 'info',
    tag: 'updated',
    sticky: true,
    action: { label: UPDATED.reload, run: () => window.location.reload() },
    sound: false,
    notifications: false,
  });
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw timedOut(err) ? new Error(REQUEST_TIMEOUT) : err;
  }
  noticeVersion(res.headers.get(VERSION_HEADER));
  let data: unknown = null;
  try {
    data = await res.json();
  } catch (err) {
    if (timedOut(err)) throw new Error(REQUEST_TIMEOUT);
    // Every API answer is JSON, so a body that isn't is a page from something in between: a
    // proxy's error page (the generic message below), or a forward-auth proxy's sign-in page,
    // which comes as a 200 once its session runs out and must not pass for an empty answer.
    if (res.ok) throw new ApiError(res.status, UNREADABLE_ANSWER(res.status), null);
  }
  if (!res.ok) {
    // A proxy in front can answer an error as JSON of another shape, so `error` counts only as a string.
    const error = (data as { [K in keyof ErrorResponse]?: unknown } | null)?.error;
    const message = typeof error === 'string' ? error : REQUEST_FAILED(res.status);
    // The login route answers 401 for a wrong password; that is not a lost session. The event
    // makes AuthGate ask /api/auth/me again, which the app never answers with a 401: one from
    // there comes from a proxy in front, and announcing it would ask /me again, forever.
    if (res.status === 401 && path !== '/api/auth/login' && path !== '/api/auth/me') window.dispatchEvent(new Event(UNAUTHENTICATED_EVENT));
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
/**
 * The body of PUT /api/settings and of useSettings().update: only what changed. mergeSettings
 * merges `alarms` (per alarm and field), `sounds` (per event) and `retention` (per field) onto
 * the stored copy, so a save that names one field leaves another device's change to the rest
 * alone. Lists (`timerMinutes`, `layout`) go whole.
 */
export type SettingsPatch = Partial<Omit<Settings, 'alarms' | 'sounds' | 'retention'>> & {
  alarms?: { [K in keyof Settings['alarms']]?: Partial<Settings['alarms'][K]> };
  sounds?: Partial<Settings['sounds']>;
  retention?: Partial<Settings['retention']>;
};

export const getSettings = () => request<Settings>('GET', '/api/settings');
export const putSettings = (patch: SettingsPatch) => request<Settings>('PUT', '/api/settings', patch);
export const resetSettings = () => request<Settings>('DELETE', '/api/settings');

// ----- days -----
/** The body of PUT /days/:date/retro: a field left out keeps its stored value. */
export type RetroPatch = { note?: string; done?: boolean };

export const getDay = (date: string) => request<Day>('GET', `/api/days/${date}`);
/**
 * A day's punch times, and those of `base`, the rows they were built on, so the server keeps a
 * punch another device saved since (`mergePunches`). Only the times go: each row's position and
 * kind come from its place.
 */
export const putPunches = (date: string, punches: Punch[], base: Punch[]) => {
  const times = (rows: Punch[]) => rows.map((p) => ({ at: p.at }));
  return request<PunchesResponse>('PUT', `/api/days/${date}/punches`, { punches: times(punches), base: times(base) });
};
/**
 * A day's list, and `base`, the list it was built on, so the server keeps what another device
 * changed since (`mergePriorities`). A row naming a
 * task the server doesn't hold makes it, and a row whose name or category differs from its base
 * row's renames or files the task on every day.
 */
export const putPriorities = (date: string, priorities: Priority[], base: Priority[]) =>
  request<PrioritiesResponse>('PUT', `/api/days/${date}/priorities`, { priorities, base });
export const putOvertime = (date: string, approved: boolean) => request<OvertimeResponse>('PUT', `/api/days/${date}/overtime`, { approved });
export const putTarget = (date: string, workMinutes: number | null) => request<TargetResponse>('PUT', `/api/days/${date}/target`, { workMinutes });
export const putRetro = (date: string, patch: RetroPatch) => request<RetroResponse>('PUT', `/api/days/${date}/retro`, patch);
export const getRange = (from: string, to: string) => request<RangeResponse>('GET', `/api/days/range?from=${from}&to=${to}`);
export const getPruneInfo = (before: string) => request<PruneInfo>('GET', `/api/days/prune?before=${before}`);
export const pruneDays = (before: string) => request<PruneResult>('POST', '/api/days/prune', { before });

// ----- sessions -----
/**
 * What the log and the timer bar change on a session (PATCH /sessions/:id also takes
 * plannedSeconds). `categoryUid` is one picked in the log, which the server takes only for a
 * session left with no task: one with a task counts under the task's category.
 */
export type SessionEdit = { label?: string; priorityUid?: string | null; categoryUid?: string | null };

export const getRunning = () => request<RunningResponse>('GET', '/api/sessions/running');
export const startSession = (date: string, plannedSeconds: number, label: string, priorityUid: string | null) =>
  request<SessionResponse>('POST', `/api/days/${date}/sessions`, { plannedSeconds, label, priorityUid });
export const patchSession = (id: number, patch: SessionEdit & { plannedSeconds?: number }) => request<SessionResponse>('PATCH', `/api/sessions/${id}`, patch);
export const pauseSession = (id: number) => request<SessionResponse>('POST', `/api/sessions/${id}/pause`);
export const resumeSession = (id: number) => request<SessionResponse>('POST', `/api/sessions/${id}/resume`);
/**
 * `expect` is the plan and pause an automatic finish judged the session by: the server refuses
 * (409) a session another device has changed since. A finish by hand sends none.
 */
export const finishSession = (id: number, countOverrun = false, expect?: Pick<Session, 'plannedSeconds' | 'pausedAt'>) =>
  request<SessionResponse>(
    'POST',
    `/api/sessions/${id}/finish`,
    countOverrun || expect ? { ...(countOverrun && { countOverrun }), ...(expect && { expect }) } : undefined,
  );
export const cancelSession = (id: number) => request<SessionResponse>('POST', `/api/sessions/${id}/cancel`);
export const deleteSession = (id: number) => request<OkResponse>('DELETE', `/api/sessions/${id}`);

// ----- breaks -----
export const startBreak = (date: string, plannedSeconds: number) => request<BreakResponse>('POST', `/api/days/${date}/breaks`, { plannedSeconds });
export const endBreak = (id: number) => request<BreakEndResponse>('POST', `/api/breaks/${id}/end`);
export const deleteBreak = (id: number) => request<OkResponse>('DELETE', `/api/breaks/${id}`);

// ----- board -----
/**
 * POST /items: a task made on the board, in `lane` before `before` there (null: the end), or a
 * recurring priority made in Settings, with its `weekdays`. A uid the server holds answers the
 * board as it is, so a retry adds nothing.
 */
export type NewItem = Pick<BoardCard, 'uid' | 'title' | 'categoryUid'> & ({ lane: OpenLane; before: string | null } | { weekdays: number[] });
/**
 * PATCH /items/:uid: a field left out keeps its value. `before` alone reorders the task's lane;
 * `lane` is for a one-off task, and `weekday` sets or clears one ISO weekday (1..7) of a recurring
 * priority, so a change another device made to its other days stands. A rename, a category or a
 * note reaches every day the task is on.
 */
export type ItemPatch = {
  title?: string;
  categoryUid?: string | null;
  note?: string;
  lane?: OpenLane;
  before?: string | null;
  weekday?: { day: number; on: boolean };
};
/** POST /board/categories: a new category, or a removed one brought back under its own uid. */
export type NewCategory = Pick<Category, 'uid' | 'name' | 'color'>;
/** PATCH /board/categories/:uid: a field left out keeps its value. */
export type CategoryPatch = Partial<Pick<Category, 'name' | 'color'>>;

export const getBoard = () => request<Board>('GET', '/api/board');
export const addItem = (item: NewItem) => request<Board>('POST', '/api/items', item);
export const editItem = (uid: string, patch: ItemPatch) => request<Board>('PATCH', `/api/items/${uid}`, patch);
/**
 * A one-off task deleted everywhere: off every day's list, its sessions kept as unplanned time
 * under its name. A recurring priority is removed instead: it stops repeating, and the days it was
 * on keep it.
 */
export const deleteItem = (uid: string) => request<Board>('DELETE', `/api/items/${uid}`);
export const addCategory = (category: NewCategory) => request<Board>('POST', '/api/board/categories', category);
export const patchCategory = (uid: string, patch: CategoryPatch) => request<Board>('PATCH', `/api/board/categories/${uid}`, patch);
/** Removes it from use: the server keeps it, archived, so past time keeps its name. */
export const deleteCategory = (uid: string) => request<Board>('DELETE', `/api/board/categories/${uid}`);
