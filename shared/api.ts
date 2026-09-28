/**
 * The JSON the API speaks, shared by the server that builds it and the client that reads
 * it. Server builders are annotated with these types so a renamed field is a type error on
 * both sides, not a test failure. No imports (settings have their own file); `emptyDay` is the one function.
 */

/**
 * How long each free-text field may be. The server cuts anything longer; the inputs set
 * `maxLength` from the same numbers so a user never types past what will be kept.
 */
export const LIMITS = {
  sessionLabel: 200,
  sessionNotes: 2000,
  priorityText: 500,
  retroNote: 4000,
} as const;

/** A password's length: the server refuses one outside it, and the new-password inputs take `minLength` and `maxLength` from it. */
export const PASSWORD_LENGTH = { min: 8, max: 200 } as const;

/**
 * Position 0 = clock in, 1 = lunch out, 2 = lunch in, 3+ = extra out/in pairs, and the last
 * row (always an odd position ≥ 3) is the final clock out.
 */
export interface Punch {
  position: number;
  kind: 'in' | 'out';
  at: number | null;
}

/**
 * Positions are 1-based and contiguous; only rows that exist are stored. `uid` is the
 * stable id sessions point at (null until the row has text); `addedAt` is when it got text.
 */
export interface Priority {
  position: number;
  text: string;
  done: boolean;
  uid: string | null;
  addedAt: number | null;
}

export type SessionStatus = 'running' | 'completed' | 'cancelled';

export interface Session {
  id: number;
  date: string;
  label: string;
  notes: string;
  plannedSeconds: number;
  startedAt: number;
  endedAt: number | null;
  status: SessionStatus;
  /** Pauses that have ended, in total; the open one (`pausedAt`) is not in here yet. */
  pausedSeconds: number;
  /** When the current pause began; null while counting down or once ended. */
  pausedAt: number | null;
  /** Focus time once ended: the span minus its pauses. */
  durationSeconds: number | null;
  /** The priority this session was for; null (or a removed row's uid) means unplanned. */
  priorityUid: string | null;
}

/** `GET /days/:date` and each entry of `GET /days/range`. */
export interface Day {
  date: string;
  punches: Punch[];
  priorities: Priority[];
  /** Silences this day's clock-out alarm only; meal alarms are unaffected. */
  overtimeApproved: boolean;
  /** The retrospective's "why" note and when it was marked reviewed (null = not yet). */
  retroNote: string;
  retroAt: number | null;
  /** This day's own work-day length in minutes (a half day); null means the user's usual one. */
  workMinutes: number | null;
  sessions: Session[];
  /** By start. */
  breaks: Break[];
}

/**
 * A break between focus sessions. `endedAt` is set to the planned end when it starts and moved
 * back if it is ended early, so a break is running while `endedAt` is ahead of now, and one
 * that ended before `startedAt + plannedSeconds` was cut short.
 */
export interface Break {
  id: number;
  date: string;
  plannedSeconds: number;
  startedAt: number;
  endedAt: number;
}

/** A date with nothing stored yet: what `GET /days/:date` answers for it, and where an edit to a day the client never loaded starts. */
export function emptyDay(date: string): Day {
  return { date, punches: [], priorities: [], overtimeApproved: false, retroNote: '', retroAt: null, workMinutes: null, sessions: [], breaks: [] };
}

/** What `GET /days/prune?before=` would delete, plus the server-wide ceiling if one is set. */
export interface PruneInfo {
  before: string;
  matching: number;
  total: number;
  oldest: string | null;
  serverMaxDays: number | null;
}

/** `GET /days/range?from&to`: the days that exist in the range, oldest first. */
export interface RangeResponse {
  days: Day[];
}

/** `POST /days/prune`: how many days went. */
export interface PruneResult {
  deleted: number;
}

/** `PUT /days/:date/punches`: the rows as stored, kinds filled in. */
export interface PunchesResponse {
  punches: Punch[];
}

/** `PUT /days/:date/priorities`: the rows as stored, uids and addedAt filled in. */
export interface PrioritiesResponse {
  priorities: Priority[];
}

/** `PUT /days/:date/overtime`. */
export interface OvertimeResponse {
  overtimeApproved: boolean;
}

/** `PUT /days/:date/retro`: the note and the first reviewed-at, as stored. */
export interface RetroResponse {
  retroNote: string;
  retroAt: number | null;
}

/** `PUT /days/:date/target`: the day's own work-day length as stored (null = the usual one). */
export interface TargetResponse {
  workMinutes: number | null;
}

/** Every session route that answers with one session: start, PATCH, pause, resume, finish, cancel. */
export interface SessionResponse {
  session: Session;
}

/** Starting a break. */
export interface BreakResponse {
  break: Break;
}

/** `POST /breaks/:id/end`: the break as it ended, or null when it ran under a minute and was dropped. */
export interface BreakEndResponse {
  break: Break | null;
}

/** The 409 from starting a break while a focus timer runs. */
export interface BreakConflict {
  error: string;
}

/** `GET /sessions/running`. */
export interface RunningResponse {
  session: Session | null;
}

/** The 409 from starting a timer while one runs (on this device or another): the one that runs. */
export interface SessionConflict {
  error: string;
  session: Session;
}

/** A write with nothing else to report (logout, password change, a delete). */
export interface OkResponse {
  ok: true;
}

export const AUTH_MODES = ['none', 'local', 'oidc'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export interface PublicUser {
  id: number;
  name: string;
  username: string | null;
  isAdmin: boolean;
  kind: 'default' | 'local' | 'oidc';
  /** Signed in with a temporary password (an admin's, or one the CLI generated): the app asks for their own before anything else. */
  mustChangePassword: boolean;
}

/** `GET /auth/me` in every auth mode. */
export interface AuthInfo {
  mode: AuthMode;
  setupRequired: boolean;
  user: PublicUser | null;
  /** The session cookie is marked Secure (APP_URL is https): a page opened over plain http cannot keep it. */
  cookieSecure: boolean;
}

/** `POST /auth/setup`, `POST /auth/login` and an admin's `POST /auth/users`. */
export interface UserResponse {
  user: PublicUser;
}

/** An admin's `GET /auth/users`. */
export interface UsersResponse {
  users: PublicUser[];
}

/** `POST /auth/logout`: under OIDC, where to send the browser to end the provider's session too. */
export interface LogoutResponse {
  ok: true;
  redirect?: string | null;
}
