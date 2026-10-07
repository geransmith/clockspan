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
  SessionResponse,
  Settings,
  TargetResponse,
  UserResponse,
  UsersResponse,
} from './types';
import { ApiError } from './lib/apiError';
import { REQUEST_FAILED, REQUEST_TIMEOUT, UNREADABLE_ANSWER } from './lib/copy';

export const UNAUTHENTICATED_EVENT = 'focus:unauthenticated';

/**
 * How long a request may take, answer included. `fetch` has no limit of its own: one that never
 * answers (a phone changing networks mid-request) would hold whatever waits behind it until the
 * browser gave up minutes later, with nothing on screen meanwhile: the writes queued after it in
 * its store (the day's, the timer's or the settings'), or the later refreshes of a day whose read
 * is still out.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

const timedOut = (err: unknown): boolean => err instanceof DOMException && err.name === 'TimeoutError';

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
    if (res.ok) throw new ApiError(res.status, UNREADABLE_ANSWER(res.status), null);
  }
  if (!res.ok) {
    // Partial: a proxy in front can answer an error as JSON of another shape.
    const message = (data as Partial<ErrorResponse> | null)?.error ?? REQUEST_FAILED(res.status);
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

/**
 * What PUT /days/:date/priorities takes beside the list. `base`: the list this one was built on,
 * so the server keeps what another device changed since (`mergePriorities`); without it the list
 * replaces the stored one. `cards`: make a board card for each text row that has none, sent
 * while the board is on and the list's day is today or later (the server never decides what
 * today is). `touched`: the cards a board action handled through their rows, which the server
 * then leaves where the board put them.
 */
export type PrioritiesPut = { base?: Priority[]; cards?: boolean; touched?: string[] };

export const getDay = (date: string) => request<Day>('GET', `/api/days/${date}`);
export const putPunches = (date: string, punches: Punch[]) =>
  request<PunchesResponse>('PUT', `/api/days/${date}/punches`, { punches: punches.map((p) => ({ at: p.at })) });
export const putPriorities = (date: string, priorities: Priority[], put: PrioritiesPut) =>
  request<PrioritiesResponse>('PUT', `/api/days/${date}/priorities`, { priorities, ...put });
export const putOvertime = (date: string, approved: boolean) => request<OvertimeResponse>('PUT', `/api/days/${date}/overtime`, { approved });
export const putTarget = (date: string, workMinutes: number | null) => request<TargetResponse>('PUT', `/api/days/${date}/target`, { workMinutes });
export const putRetro = (date: string, patch: RetroPatch) => request<RetroResponse>('PUT', `/api/days/${date}/retro`, patch);
export const getRange = (from: string, to: string) => request<RangeResponse>('GET', `/api/days/range?from=${from}&to=${to}`);
export const getPruneInfo = (before: string) => request<PruneInfo>('GET', `/api/days/prune?before=${before}`);
export const pruneDays = (before: string) => request<PruneResult>('POST', '/api/days/prune', { before });

// ----- sessions -----
/**
 * What the log and the timer bar change on a session (PATCH /sessions/:id also takes
 * plannedSeconds). `categoryUid` is the one picked in the log, for a session not on a written row.
 */
export type SessionEdit = { label?: string; priorityUid?: string | null; categoryUid?: string | null };

export const getRunning = () => request<RunningResponse>('GET', '/api/sessions/running');
export const startSession = (date: string, plannedSeconds: number, label: string, priorityUid: string | null) =>
  request<SessionResponse>('POST', `/api/days/${date}/sessions`, { plannedSeconds, label, priorityUid });
export const patchSession = (id: number, patch: SessionEdit & { plannedSeconds?: number }) => request<SessionResponse>('PATCH', `/api/sessions/${id}`, patch);
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

// ----- board -----
/**
 * POST /board/cards: a new card, or where an existing one goes (a park), with its title and
 * category. The uid is one the board minted, or the parked row's cardUid.
 */
export type NewCard = Pick<BoardCard, 'uid' | 'title' | 'categoryUid'> & { lane: OpenLane; before: string | null };
/**
 * PATCH /board/cards/:uid: a field left out keeps its value; `before` alone reorders the card's
 * lane. `today` is the client's date key: while a row on that day's list or a later one is
 * linked to the card, the server refuses the edit (409).
 */
export type CardPatch = { today: string; title?: string; categoryUid?: string | null; lane?: OpenLane; before?: string | null };
/** POST /board/categories: a new category, or a removed one brought back under its own uid. */
export type NewCategory = Pick<Category, 'uid' | 'name' | 'color'>;
/** PATCH /board/categories/:uid: a field left out keeps its value. */
export type CategoryPatch = Partial<Pick<Category, 'name' | 'color'>>;

export const getBoard = () => request<Board>('GET', '/api/board');
export const addCard = (card: NewCard) => request<Board>('POST', '/api/board/cards', card);
export const patchCard = (uid: string, patch: CardPatch) => request<Board>('PATCH', `/api/board/cards/${uid}`, patch);
export const deleteCard = (uid: string) => request<Board>('DELETE', `/api/board/cards/${uid}`);
export const addCategory = (category: NewCategory) => request<Board>('POST', '/api/board/categories', category);
export const patchCategory = (uid: string, patch: CategoryPatch) => request<Board>('PATCH', `/api/board/categories/${uid}`, patch);
/** Removes it from use: the server keeps it, archived, so past time keeps its name. */
export const deleteCategory = (uid: string) => request<Board>('DELETE', `/api/board/categories/${uid}`);
