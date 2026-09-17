export type CardId = 'timeclock' | 'priorities' | 'timer' | 'log';

export interface AlarmSettings {
  enabled: boolean;
  leadMinutes: number[];
  onDue: boolean;
  overdueEveryMinutes: number;
}

export type AlarmId = 'lunchBy' | 'clockOut';

export interface Settings {
  workMinutes: number;
  lunchDeadlineMinutes: number;
  lunchMinutes: number;
  adjustStepMinutes: number;
  sound: boolean;
  notifications: boolean;
  keepScreenAwake: boolean;
  alarms: Record<AlarmId, AlarmSettings>;
  layout: { id: CardId; visible: boolean }[];
}

/** Position 0 = clock in, 1 = lunch out, 2 = lunch in, 3+ = extra out/in pairs. */
export interface Punch {
  position: number;
  kind: 'in' | 'out';
  at: number | null;
}

export interface Priority {
  position: 1 | 2 | 3;
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
