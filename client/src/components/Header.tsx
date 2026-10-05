import { useRef } from 'react';
import { useAuth } from '../auth/AuthGate';
import type { Route } from '../hooks/useRoute';
import { CONFIRM } from '../lib/copy';
import { addDays } from '../../../shared/dates.js';
import { dayName, formatDateLong } from '../lib/format';
import { ChevronLeft, ChevronRight, Gear, Layout, List } from './Icons';
import { Avatar } from './Avatar';

interface Props {
  view: Route['view'];
  /** The date on screen (today when the route holds none). */
  date: string;
  today: string;
  customize: boolean;
  onNavigate: (next: Partial<Route>, opts?: { replace?: boolean }) => void;
  onToggleCustomize: () => void;
  onOpenSettings: () => void;
}

export function Header({ view, date, today, customize, onNavigate, onToggleCustomize, onOpenSettings }: Props) {
  const { auth, signOut } = useAuth();
  // Typing a date fires a change with a whole date per digit (a year goes 0002, 0020, 0202, 2026),
  // so only the first change in a visit to the field adds a history entry and the rest replace it.
  const typed = useRef(false);
  const onSheet = view === 'sheet';
  const isToday = date === today;
  // "Yesterday" gets the date underneath; any other day's name already is the date (the sheet never shows a future day).
  const name = dayName(date, today);
  const long = formatDateLong(date);

  return (
    <header className="topbar">
      <div className="topbar-row">
        <button className="brand" onClick={() => onNavigate({ view: 'sheet', date: null })} title="Go to today">
          <img src="/icons/icon.svg" alt="" width={28} height={28} />
          Clockspan
        </button>
        <div className="topbar-actions">
          {onSheet && (
            <button className="btn btn-icon" onClick={onToggleCustomize} aria-pressed={customize} title={customize ? 'Done customizing' : 'Customize layout'}>
              <Layout />
              <span className="btn-text">{customize ? 'Done' : 'Customize'}</span>
            </button>
          )}
          <button className="btn btn-icon" onClick={() => onNavigate({ view: onSheet ? 'history' : 'sheet' })} aria-pressed={!onSheet} title="History">
            <List />
            <span className="btn-text">History</span>
          </button>
          <button className="btn btn-icon" onClick={onOpenSettings} title="Settings">
            <Gear />
            <span className="btn-text">Settings</span>
          </button>
          {auth.mode !== 'none' && (
            <button
              className="btn btn-ghost user-chip"
              // On a phone the avatar is all there is and the title never shows: ask before a stray tap signs out.
              onClick={() => {
                if (window.confirm(CONFIRM.signOut)) void signOut();
              }}
              title={`Signed in as ${auth.user.name}. Click to sign out.`}
            >
              <Avatar name={auth.user.name} />
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
              onFocus={() => {
                typed.current = false;
              }}
              onChange={(e) => {
                const v = e.target.value;
                // A year below 1000 is a part-typed one, and shared/dates can't read it.
                if (v < '1000') return;
                onNavigate({ date: v }, { replace: typed.current });
                typed.current = true;
              }}
              onClick={(e) => {
                // The input is invisible over the label, and desktop Chromium opens its picker only from
                // the calendar icon at the input's right end, so a click anywhere on the label asks for it.
                try {
                  e.currentTarget.showPicker();
                } catch {
                  // No showPicker (an older browser): the click still focuses the field.
                }
              }}
              aria-label="Pick a date"
            />
          </label>
          <button className="btn btn-icon" onClick={() => onNavigate({ date: addDays(date, 1) })} aria-label="Next day" disabled={date >= today}>
            <ChevronRight />
          </button>
          {!isToday && (
            <button className="btn btn-ghost" onClick={() => onNavigate({ date: null })}>
              Today
            </button>
          )}
        </div>
      )}
    </header>
  );
}
