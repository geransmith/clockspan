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
 * A day's stored list is the one a client last sent, merged with what other devices saved since
 * the copy it was built on (`mergePriorities`), in position order (1-based and contiguous): the
 * card saves the rows it shows, empty ones included, and a day never edited has none. `uid` is
 * the stable id sessions point at (null until the row has text); `addedAt` is when it got text.
 * Each day's row has its own uid; the links below tie the rows of one task across days. They are
 * soft links, checked for shape only: a uid with nothing behind it reads as none, and a null link
 * matches nothing. A row carried to another day gets a fresh uid and keeps its links.
 */
export interface Priority {
  position: number;
  text: string;
  done: boolean;
  uid: string | null;
  addedAt: number | null;
  /** The board card this row is on its day. Set when the row arrives on a list, or by the server when a save makes the row's card; fixed once stored. */
  cardUid: string | null;
  /** The recurring priority this row was added from; fixed once stored. Never set together with `cardUid`. */
  recurringUid: string | null;
  /** The category it counts under. Kept when the row's text is cleared. */
  categoryUid: string | null;
}

/** A board card's column while no row of today's list is linked to it. In progress is never stored: it is today's open rows. */
export const LANES = ['later', 'next', 'done'] as const;
export type Lane = (typeof LANES)[number];
/** The lanes the board can put a card in: Done is reached only through a ticked row. */
export type OpenLane = Exclude<Lane, 'done'>;

/**
 * A board card. While a row of today's list is linked to it (its `cardUid`), that row decides
 * where it shows: open in In progress, ticked in Done, emptied nowhere. Otherwise `held`, then
 * `listDate`, then its `lane`. A priorities save keeps its title and lane in step with its
 * latest linked row.
 */
export interface BoardCard {
  uid: string;
  title: string;
  /** The category it counts under; a priorities save copies its row's when it changes there. */
  categoryUid: string | null;
  lane: Lane;
  /** 1..n within Later or Next; 0 in Done, which goes by `doneAt`. */
  position: number;
  createdAt: number;
  doneAt: number | null;
  /** The latest day whose list holds a row linked to this card, with text or emptied; null with none. After the client's today, the card is planned. */
  listDate: string | null;
  /** Made by a priorities save and never handled on the board, with its row on `listDate` emptied: shown nowhere until that row has text again or is removed. */
  held: boolean;
}

/** The colours a category can take. There are fewer than categories can be, so they repeat. */
export const CATEGORY_COLORS = ['blue', 'teal', 'green', 'gold', 'orange', 'pink', 'purple', 'grey'] as const;
export type CategoryColor = (typeof CATEGORY_COLORS)[number];

/**
 * What a row, a card or a session counts under (their `categoryUid`). Names are unique among a
 * user's categories in use, whatever their case or spacing (`sameText`).
 */
export interface Category {
  uid: string;
  name: string;
  color: CategoryColor;
  /** Removed in Settings: kept so past time keeps its name, and never offered. */
  archived: boolean;
}

/**
 * A recurring priority, offered on today's list on its weekdays (the client decides which day
 * is today). The rows it adds carry its uid as `recurringUid`, and keep it after it is deleted.
 */
export interface Recurring {
  uid: string;
  /** The text of the rows it adds. */
  title: string;
  /** The category the rows it adds count under. */
  categoryUid: string | null;
  /** ISO weekdays, Monday 1 to Sunday 7, ascending, at least one. */
  weekdays: number[];
}

/**
 * `GET /board`, and the answer to every board write: Later and Next in order, then the cards
 * done in the last `BOARD_LIMITS.doneWindowDays`; every category, removed ones included, in the
 * order they were made; and the recurring priorities in the order they were made.
 */
export interface Board {
  cards: BoardCard[];
  categories: Category[];
  recurring: Recurring[];
}

/** The server's caps on the board: sanity limits for an internet-exposed install, not product limits. */
export const BOARD_LIMITS = {
  /** Cards in Later and Next together. */
  openCards: 300,
  /** Categories not removed. */
  categories: 100,
  /** Categories stored, removed ones included, so making and removing them can't grow the table for ever. */
  categoriesStored: 1000,
  /** Recurring priorities. */
  recurring: 100,
  /** How far back `GET /board` sends Done cards: a week, and a day of slack for the client's zone. */
  doneWindowDays: 8,
} as const;

/** What a session has whatever its status. */
interface SessionFields {
  id: number;
  date: string;
  label: string;
  plannedSeconds: number;
  startedAt: number;
  /** Pauses that have ended, in total; the open one (`pausedAt`) is not in here yet. */
  pausedSeconds: number;
  /** When the current pause began; null while counting down or once ended. */
  pausedAt: number | null;
  /** The priority this session was for; null (or a removed row's uid) means unplanned. */
  priorityUid: string | null;
  /**
   * Picked in the log for a session not on a written row, or the category of the row it was on,
   * which the server copies here when a priorities save removes that row. A session on a written
   * row counts under that row's category instead.
   */
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
 * `PUT /days/:date/priorities`: the rows as stored once the save is merged with the day's list
 * (`mergePriorities`), uids and addedAt filled in, and each stored row's links as stored,
 * with the `cardUid` of each card the save made.
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

/** The 409 from starting a timer while one runs (on this device or another): the one that runs. */
export interface SessionConflict extends ErrorResponse {
  session: Session;
}

/** A write with nothing else to report (a password change, a delete), and the health check. */
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
