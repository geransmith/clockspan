import { useAuth } from '../auth/AuthGate';
import type { Route } from '../hooks/useRoute';
import { addDays, formatDateLong } from '../lib/format';
import { ChevronLeft, ChevronRight, Gear, Layout, List } from './Icons';

interface Props {
  route: Route;
  today: string;
  customize: boolean;
  onNavigate: (next: Partial<Route>) => void;
  onToggleCustomize: () => void;
  onOpenSettings: () => void;
}

export function Header({ route, today, customize, onNavigate, onToggleCustomize, onOpenSettings }: Props) {
  const { auth, signOut } = useAuth();
  const onSheet = route.view === 'sheet';
  const isToday = route.date === today;
  const label = isToday ? 'Today' : route.date === addDays(today, -1) ? 'Yesterday' : formatDateLong(route.date);

  return (
    <header className="topbar">
      <div className="topbar-row">
        <button className="brand" onClick={() => onNavigate({ view: 'sheet', date: today })} aria-label="Go to today">
          <span className="brand-dot" aria-hidden="true" />
          Focus Sheet
        </button>
        <div className="topbar-actions">
          {onSheet && (
            <button
              className={`btn btn-icon${customize ? ' is-active' : ''}`}
              onClick={onToggleCustomize}
              aria-pressed={customize}
              title={customize ? 'Done customizing' : 'Customize layout'}
            >
              <Layout />
              <span className="btn-text">{customize ? 'Done' : 'Customize'}</span>
            </button>
          )}
          <button
            className={`btn btn-icon${!onSheet ? ' is-active' : ''}`}
            onClick={() => onNavigate({ view: onSheet ? 'history' : 'sheet' })}
            aria-pressed={!onSheet}
            title="History"
          >
            <List />
            <span className="btn-text">History</span>
          </button>
          <button className="btn btn-icon" onClick={onOpenSettings} title="Settings">
            <Gear />
            <span className="btn-text">Settings</span>
          </button>
          {auth.mode !== 'none' && auth.user && (
            <button className="btn btn-ghost user-chip" onClick={() => void signOut()} title={`Signed in as ${auth.user.name}. Click to sign out.`}>
              <span className="avatar" aria-hidden="true">
                {auth.user.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="btn-text">Sign out</span>
            </button>
          )}
        </div>
      </div>
      {onSheet && (
        <div className="topbar-row datenav">
          <button className="btn btn-icon" onClick={() => onNavigate({ date: addDays(route.date, -1) })} aria-label="Previous day">
            <ChevronLeft />
          </button>
          <label className="datenav-label">
            <span className="datenav-text">{label}</span>
            {!isToday && <span className="datenav-sub">{formatDateLong(route.date)}</span>}
            <input
              className="datenav-input"
              type="date"
              value={route.date}
              max={today}
              onChange={(e) => e.target.value && onNavigate({ date: e.target.value })}
              aria-label="Pick a date"
            />
          </label>
          <button className="btn btn-icon" onClick={() => onNavigate({ date: addDays(route.date, 1) })} aria-label="Next day" disabled={isToday}>
            <ChevronRight />
          </button>
          {!isToday && (
            <button className="btn btn-ghost" onClick={() => onNavigate({ date: today })}>
              Today
            </button>
          )}
        </div>
      )}
    </header>
  );
}
