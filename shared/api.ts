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
  priorityText: 500,
  retroNote: 4000,
  categoryName: 40,
  itemNote: 1000,
} as const;

/** A password's length: the server refuses one outside it, and the new-password inputs take `minLength` and `maxLength` from it. */
export const PASSWORD_LENGTH = { min: 8, max: 200 } as const;

/**
 * A username: its length, the characters it may use as a `pattern`, and those characters in
 * words. The server trims, then refuses anything outside them; the username inputs take their
 * `minLength`, `maxLength`, `pattern` and `title` from here. The pattern allows spaces around
 * the name because the server trims them, and it must work where a browser matches an input's
 * whole value under the `v` flag, which wants a `-` in a class escaped.
 */
export const USERNAME = { min: 2, max: 40, pattern: '\\s*[A-Za-z0-9._\\-]+\\s*', chars: 'letters, numbers, . _ and -' } as const;

/**
 * Position 0 = clock in, 1 = lunch out, 2 = lunch in, 3+ = extra out/in pairs; `kind` is the
 * position's parity (`kindForPosition`). The server stores the rows in the order sent, up to
 * `MAX_PUNCHES`, and a day never punched has none; the day store pads each day it holds to the
 * fixed rows, with the Clock out last at an odd position ≥ 3 (`normalizePunches`).
 */
export interface Punch {
  position: number;
  kind: 'in' | 'out';
  at: number | null;
}

/**
 * A task as it stands on one day's list: a day's list names the tasks on it (`uid`), each with its
 * place, its tick that day and when it was put there, and the server joins the rest from the task
 * itself, which is stored once, so a rename or a category shows on every day. The stored list is
 * the one a client last sent, merged with what other devices saved since the copy it was built on
 * (`mergePriorities`), in position order. Only rows with a task are stored: a client pads the list
 * with free rows (uid null, text ''), so positions can have gaps where free rows sat. A day never
 * edited has none.
 */
export interface Priority {
  /** Its row on the sheet, from 1. */
  position: number;
  /** The task's current name; '' on a free row. */
  text: string;
  /** Ticked on this day. */
  done: boolean;
  /** The task's uid, which sessions point at; null only on a free row. */
  uid: string | null;
  /** When it was put on this day's list. */
  addedAt: number | null;
  /** The task's current category. */
  categoryUid: string | null;
  /** The task's note; '' with none. */
  note: string;
  /** Read only: the task is a recurring priority. */
  recurring: boolean;
  /** Read only: a recurring priority that stopped repeating, or a task the one-item migration (server/migrations/oneItem.ts) archived. */
  archived: boolean;
  /** Read only: how many days' lists hold the task. */
  listed: number;
  /** Read only: how many of those days are before this one. */
  earlier: number;
  /** Read only: seconds of completed sessions on the task on other days (the day's own are in its log). */
  logged: number;
}

/** The board's lanes a task can be placed in. In progress is today's list and Done a task whose latest entry is ticked, so neither is stored. */
export const OPEN_LANES = ['later', 'next'] as const;
export type OpenLane = (typeof OPEN_LANES)[number];

/**
 * A one-off task as the board sees it. Where it shows is worked out from its latest entry
 * (`listDate`, `listDone`) and its lane: on today's list it is that row, a ticked latest entry is
 * Done, and a task with no lane whose latest entry was left open shows in Next for
 * `LOOKBACK_DAYS`.
 */
export interface BoardCard {
  uid: string;
  title: string;
  categoryUid: string | null;
  /** '' with none. */
  note: string;
  /** Later or Next, where the board put it; null: in neither. */
  lane: OpenLane | null;
  /** 1..n within its lane; 0 with none. */
  position: number;
  createdAt: number;
  /** The latest day whose list holds it; null with none. */
  listDate: string | null;
  /** That day's tick: the task is done. */
  listDone: boolean;
  /** How many days' lists hold it. */
  listed: number;
  /** Seconds of completed sessions on it, every day. */
  logged: number;
}

/** The colours a category can take. There are fewer than categories can be, so they repeat. */
export const CATEGORY_COLORS = ['blue', 'teal', 'green', 'gold', 'orange', 'pink', 'purple', 'grey'] as const;
export type CategoryColor = (typeof CATEGORY_COLORS)[number];

/**
 * What a task or a session with no task counts under (their `categoryUid`). Names are unique among
 * a user's categories in use, whatever their case or spacing (`sameText`).
 */
export interface Category {
  uid: string;
  name: string;
  color: CategoryColor;
  /** Removed in Settings: kept so past time keeps its name, and never offered. */
  archived: boolean;
}

/**
 * A recurring priority: a task offered on today's list on its weekdays (the client decides which
 * day is today). The rows it adds name it by its uid, so a rename reaches them all.
 */
export interface Recurring {
  uid: string;
  /** Its name, on every day it was added to. */
  title: string;
  /** The category it counts under, on every day it was added to. */
  categoryUid: string | null;
  /** Its note, on every day it was added to; '' with none. */
  note: string;
  /** ISO weekdays, Monday 1 to Sunday 7, ascending, at least one. */
  weekdays: number[];
}

/**
 * `GET /board`, and the answer to every board and task write: the one-off tasks in Later and Next
 * that aren't done, in order, then the others whose latest entry is from the last
 * `LOOKBACK_DAYS` (and a day) to about two months ahead; every category, removed ones included,
 * in the order they were made; and the recurring priorities not removed, in the order they were
 * made.
 */
export interface Board {
  cards: BoardCard[];
  categories: Category[];
  recurring: Recurring[];
}

/**
 * How many days back a task left open still comes back: the morning's "Still open from …" reads
 * this many days before today, and the board shows a task left open in Next for as long.
 */
export const LOOKBACK_DAYS = 14;

/** The server's caps on the board: sanity limits for an internet-exposed install, not product limits. */
export const BOARD_LIMITS = {
  /** Tasks in Later and Next that aren't done. */
  openCards: 300,
  /** Categories not removed. */
  categories: 100,
  /** Categories stored, removed ones included, so making and removing them can't grow the table for ever. */
  categoriesStored: 1000,
  /** Recurring priorities not removed. */
  recurring: 100,
} as const;

/** What a session has whatever its status. */
interface SessionFields {
  id: number;
  date: string;
  /** What it was called when it started, or its task's name at the moment it lost the task. Shown only while it has no task. */
  label: string;
  plannedSeconds: number;
  startedAt: number;
  /** Pauses that have ended, in total; the open one (`pausedAt`) is not in here yet. */
  pausedSeconds: number;
  /** When the current pause began; null while counting down or once ended. */
  pausedAt: number | null;
  /** The task this session was for; null means unplanned. Off the plan when its day's list doesn't hold it. */
  priorityUid: string | null;
  /** Read only: the task's current name; null with no task. */
  title: string | null;
  /** The category it counts under: its task's with one, else the one picked in the log or kept from a task it lost. */
  categoryUid: string | null;
}

/** A session still going, paused or not: it has no end and no focus time yet. */
export type RunningSession = SessionFields & { status: 'running'; endedAt: null; durationSeconds: null };

export type CompletedSession = SessionFields & {
  status: 'completed';
  endedAt: number;
  /** Focus time once ended: the span minus its pauses. */
  durationSeconds: number;
};

export type CancelledSession = SessionFields & { status: 'cancelled'; endedAt: number; durationSeconds: number };

export type Session = RunningSession | CompletedSession | CancelledSession;

export type SessionStatus = Session['status'];

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

/**
 * A date with nothing stored: what `GET /days/:date` answers for it, and what the day store's
 * `readRange` holds for a day it had that the range's answer leaves out (one pruned since, say).
 */
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

/**
 * `PUT /days/:date/priorities`: the day's list as stored once the save is merged with it
 * (`mergePriorities`), uids and addedAt filled in, each row with its task's name and category as
 * they stand. A row that named a deleted task is not in it.
 */
export interface PrioritiesResponse {
  priorities: Priority[];
}

/** `PUT /days/:date/overtime`. */
export type OvertimeResponse = Pick<Day, 'overtimeApproved'>;

/** `PUT /days/:date/retro`: the note and the first reviewed-at, as stored. */
export type RetroResponse = Pick<Day, 'retroNote' | 'retroAt'>;

/** `PUT /days/:date/target`: the day's own work-day length as stored (null = the usual one). */
export type TargetResponse = Pick<Day, 'workMinutes'>;

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

/** `GET /sessions/running`. */
export interface RunningResponse {
  session: Session | null;
}

/** Every refusal the API sends: the message the client shows. */
export interface ErrorResponse {
  error: string;
}

/** A write with nothing else to report (a password change, a delete), and the health check. */
export interface OkResponse {
  ok: true;
}

/**
 * The header on every signed-in data answer that names the server's version. The web app
 * compares it with its own build's and asks for a reload when they differ.
 */
export const VERSION_HEADER = 'Clockspan-Version';

/**
 * The header on every signed-in data answer that numbers the user's changes: a write moves it
 * on by one, a refused one too, and a read says where it stands.
 */
export const REVISION_HEADER = 'Clockspan-Revision';

export const AUTH_MODES = ['none', 'local', 'oidc'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export interface PublicUser {
  id: number;
  name: string;
  username: string | null;
  isAdmin: boolean;
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

/** `POST /auth/logout` under local and OIDC sign-in; under OIDC, `redirect` is where to send the browser to end the provider's session too. */
export interface LogoutResponse {
  ok: true;
  redirect?: string | null;
}
