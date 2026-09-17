export type CardId = 'timeclock' | 'priorities' | 'timer' | 'log';

export interface AlarmSettings {
  enabled: boolean;
  leadMinutes: number[];
  onDue: boolean;
  overdueEveryMinutes: number;
}

export type AlarmId = 'lunchBy' | 'clockOut' | 'secondMeal';

export interface Settings {
  workMinutes: number;
  lunchDeadlineMinutes: number;
  lunchMinutes: number;
  /** Hours *worked* after which a second meal period is due (California: 10 h). */
  secondMealAfterMinutes: number;
  adjustStepMinutes: number;
  /** Rows a fresh day's priorities card starts with. */
  priorityCount: number;
  sound: boolean;
  notifications: boolean;
  keepScreenAwake: boolean;
  /** Show the per-day "Overtime approved" switch and banner action. */
  overtimeApproval: boolean;
  alarms: Record<AlarmId, AlarmSettings>;
  layout: { id: CardId; visible: boolean }[];
}

/**
 * Position 0 = clock in, 1 = lunch out, 2 = lunch in, 3+ = extra out/in pairs, and the last
 * row (always an odd position ≥ 3) is the final clock out.
 */
export interface Punch {
  position: number;
  kind: 'in' | 'out';
  at: number | null;
}

/** Positions are 1-based and contiguous; only rows that exist are stored. */
export interface Priority {
  position: number;
  text: string;
  done: boolean;
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
  durationSeconds: number | null;
}

export interface Day {
  date: string;
  punches: Punch[];
  priorities: Priority[];
  /** Silences this day's clock-out alarm only; meal alarms are unaffected. */
  overtimeApproved: boolean;
  sessions: Session[];
}

export interface DaySummary {
  date: string;
  punches: Punch[];
  focusSeconds: number;
  prioritiesDone: number;
  prioritiesTotal: number;
}

export type AuthMode = 'none' | 'local' | 'oidc';

export interface PublicUser {
  id: number;
  name: string;
  username: string | null;
  isAdmin: boolean;
  kind: 'default' | 'local' | 'oidc';
}

export interface AuthInfo {
  mode: AuthMode;
  setupRequired: boolean;
  user: PublicUser | null;
}
