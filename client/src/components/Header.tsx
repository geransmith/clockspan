import { useRef } from 'react';
import { useAuth } from '../auth/AuthGate';
import { useSettings } from '../hooks/useSettings';
import { useShortcut } from '../hooks/useShortcuts';
import type { Route } from '../hooks/useRoute';
import { CONFIRM } from '../lib/copy';
import { addDays } from '../../../shared/dates.js';
import { dayName, formatDateLong } from '../lib/format';
import { ChevronLeft, ChevronRight, Columns, Gear, Layout, List } from './Icons';
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
  const { loaded } = useSettings();
  // Typing a date fires a change with a whole date per digit (a year goes 0002, 0020, 0202, 2026),
  // so only the first change in a visit to the field adds a history entry and the rest replace it.
  const typed = useRef(false);
  // Next day on reaching today is disabled and Today goes once pressed, so either hands the focus
  // to Previous day rather than letting it fall back to the top of the page.
  const prevDay = useRef<HTMLButtonElement>(null);
  // A key moves the focus to its button, as a click would have: the control it was on may go with the page.
  const brandButton = useRef<HTMLButtonElement>(null);
  const boardButton = useRef<HTMLButtonElement>(null);
  const historyButton = useRef<HTMLButtonElement>(null);
  const onSheet = view === 'sheet';
  const onHistory = view === 'history';
  const onBoard = view === 'board';
  const isToday = date === today;
  // "Yesterday" gets the date underneath; any other day's name already is the date (the sheet never shows a future day).
  const name = dayName(date, today);
  const long = formatDateLong(date);
  // Customize, Board, History, Settings and the user: five buttons and the brand's name don't fit
  // a 375 px phone, so the name goes there (styles.css) and the logo stays; the buttons' words
  // come back from 760 px rather than 640. Every view takes the same rule, so a page switch leaves
  // the header as it was.
  const crowded = auth.mode !== 'none';
  const toToday = () => onNavigate({ view: 'sheet', date: null });
  const toggleBoard = () => onNavigate({ view: onBoard ? 'sheet' : 'board' });
  const toggleHistory = () => onNavigate({ view: onHistory ? 'sheet' : 'history' });
  const sheetKey = useShortcut('sheet', () => {
    brandButton.current?.focus();
    toToday();
  });
  const boardKey = useShortcut('board', () => {
    boardButton.current?.focus();
    toggleBoard();
  });
  const historyKey = useShortcut('history', () => {
    historyButton.current?.focus();
    toggleHistory();
  });

  return (
    <header className="topbar">
      <div className={crowded ? 'topbar-row topbar-row--crowded' : 'topbar-row'}>
        <button ref={brandButton} className="brand" onClick={toToday} title="Go to today" aria-keyshortcuts={sheetKey}>
          <img src="/icons/icon.svg" alt="" width={28} height={28} />
          <span className="brand-name">Clockspan</span>
        </button>
        <div className="topbar-actions">
          {onSheet && (
            // Until the settings answer, the layout shown is the default one, and a change would save it whole over the user's.
            <button className="btn btn-icon" onClick={onToggleCustomize} disabled={!loaded} aria-pressed={customize} title="Customize layout">
              <Layout />
              <span className="btn-text">Customize</span>
            </button>
          )}
          <button ref={boardButton} className="btn btn-icon" onClick={toggleBoard} aria-pressed={onBoard} title="Board" aria-keyshortcuts={boardKey}>
            <Columns />
            <span className="btn-text">Board</span>
          </button>
          <button ref={historyButton} className="btn btn-icon" onClick={toggleHistory} aria-pressed={onHistory} title="History" aria-keyshortcuts={historyKey}>
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
          <button ref={prevDay} className="btn btn-icon" onClick={() => onNavigate({ date: addDays(date, -1) })} aria-label="Previous day">
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
                // A change that leaves the sheet where it is (a future date shows today) adds nothing, so it
                // mustn't turn on replace: the next change would overwrite the entry the user came from.
                if ((v >= today ? today : v) === date) return;
                onNavigate({ date: v }, { replace: typed.current });
                typed.current = true;
              }}
              onClick={(e) => {
                // A click starts a new choice: after a pick, desktop Chromium leaves focus here, so onFocus doesn't run again.
                typed.current = false;
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
          <button
            className="btn btn-icon"
            onClick={() => {
              const next = addDays(date, 1);
              onNavigate({ date: next });
              if (next >= today) prevDay.current?.focus();
            }}
            aria-label="Next day"
            disabled={date >= today}
          >
            <ChevronRight />
          </button>
          {!isToday && (
            <button
              className="btn btn-ghost"
              onClick={() => {
                onNavigate({ date: null });
                prevDay.current?.focus();
              }}
            >
              Today
            </button>
          )}
        </div>
      )}
    </header>
  );
}
