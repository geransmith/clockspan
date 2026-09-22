/**
 * The JSON the API speaks, shared by the server that builds it and the client that reads
 * it. Server builders are annotated with these types so a renamed field is a type error on
 * both sides, not a test failure. No imports (settings have their own file).
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
  sessions: Session[];
}

/** A day rolled up for the History calendar; built on the client (`daySummaryOf`) from a full `Day`. */
export interface DaySummary {
  date: string;
  punches: Punch[];
  focusSeconds: number;
  prioritiesDone: number;
  prioritiesTotal: number;
  retroAt: number | null;
}

/** What `GET /days/prune?before=` would delete, plus the server-wide ceiling if one is set. */
export interface PruneInfo {
  before: string;
  matching: number;
  total: number;
  oldest: string | null;
  serverMaxDays: number | null;
}

export type AuthMode = 'none' | 'local' | 'oidc';

export interface PublicUser {
  id: number;
  name: string;
  username: string | null;
  isAdmin: boolean;
  kind: 'default' | 'local' | 'oidc';
}

/** `GET /auth/me` in every auth mode. */
export interface AuthInfo {
  mode: AuthMode;
  setupRequired: boolean;
  user: PublicUser | null;
  /** The session cookie is marked Secure (APP_URL is https): a page opened over plain http cannot keep it. */
  cookieSecure: boolean;
}
