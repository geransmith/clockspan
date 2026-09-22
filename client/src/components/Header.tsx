import { useAuth } from '../auth/AuthGate';
import type { Route } from '../hooks/useRoute';
import { addDays, dayName, formatDateLong } from '../lib/format';
import { ChevronLeft, ChevronRight, Gear, Layout, List } from './Icons';

interface Props {
  view: Route['view'];
  /** The date on screen (today when the route holds none). */
  date: string;
  today: string;
  customize: boolean;
  onNavigate: (next: Partial<Route>) => void;
  onToggleCustomize: () => void;
  onOpenSettings: () => void;
}

export function Header({ view, date, today, customize, onNavigate, onToggleCustomize, onOpenSettings }: Props) {
  const { auth, signOut } = useAuth();
  const onSheet = view === 'sheet';
  const isToday = date === today;
  // "Yesterday" gets the date underneath; an older day's name already is the date.
  const name = dayName(date, today);
  const long = formatDateLong(date);

  return (
    <header className="topbar">
      <div className="topbar-row">
        <button className="brand" onClick={() => onNavigate({ view: 'sheet', date: today })} aria-label="Go to today">
          <span className="brand-dot" aria-hidden="true" />
          Clockspan
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
          <button className="btn btn-icon" onClick={() => onNavigate({ date: addDays(date, -1) })} aria-label="Previous day">
            <ChevronLeft />
          </button>
          <label className="datenav-label">
            <span className="datenav-text">{name}</span>
            {!isToday && name !== long && <span className="datenav-sub">{long}</span>}
            <input
              className="datenav-input"
              type="date"
              value={date}
              max={today}
              onChange={(e) => e.target.value && onNavigate({ date: e.target.value })}
              aria-label="Pick a date"
            />
          </label>
          <button className="btn btn-icon" onClick={() => onNavigate({ date: addDays(date, 1) })} aria-label="Next day" disabled={date >= today}>
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
