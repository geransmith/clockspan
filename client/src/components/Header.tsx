import { useRef } from 'react';
import { useAuth } from '../auth/AuthGate';
import { useShortcut } from '../hooks/useShortcuts';
import type { Route } from '../hooks/useRoute';
import { CONFIRM } from '../lib/copy';
import { Columns, Gear, List } from './Icons';
import { Avatar } from './Avatar';

interface Props {
  view: Route['view'];
  onNavigate: (next: Partial<Route>, opts?: { replace?: boolean }) => void;
  onOpenSettings: () => void;
}

/** The same on every view: a page's own controls (the sheet's date row and Customize) sit in the page. */
export function Header({ view, onNavigate, onOpenSettings }: Props) {
  const { auth, signOut } = useAuth();
  // A key moves the focus to its button, as a click would have: the control it was on may go with the page.
  const brandButton = useRef<HTMLButtonElement>(null);
  const boardButton = useRef<HTMLButtonElement>(null);
  const historyButton = useRef<HTMLButtonElement>(null);
  const onHistory = view === 'history';
  const onBoard = view === 'board';
  // Board, History, Settings and the user: four buttons and the brand's name don't fit a 360 px
  // phone, so the name goes there (styles.css) and the logo stays; the buttons' words come back
  // from 760 px rather than 640.
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
    </header>
  );
}
