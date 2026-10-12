import { useRef } from 'react';
import { useAuth } from '../auth/AuthGate';
import { useShortcut } from '../hooks/useShortcuts';
import type { Route } from '../hooks/useRoute';
import { CONFIRM } from '../lib/copy';
import { Columns, Gear, Inbox, List } from './Icons';
import { Avatar } from './Avatar';

interface Props {
  view: Route['view'];
  onNavigate: (next: Partial<Route>, opts?: { replace?: boolean }) => void;
  onOpenSettings: () => void;
  /** Whether the Later strip is open (on the Board too, where it is hidden). */
  laterOpen: boolean;
  /** No card can go in Later: the board's first read hasn't answered, or it is at the cap. */
  laterShut: boolean;
  /** Opens the Later strip with the focus in its box, or only focuses an open one. */
  onOpenLater: () => void;
  onCloseLater: () => void;
}

/** On the Board, Add to Later is Later's +, which the lazy Board renders: clicked inside the tap, so iOS raises the keyboard. */
const clickLaterAdd = () => document.getElementById('board-add-later-button')?.click();

/** The same on every view: a page's own controls (the sheet's date row and Customize) sit in the page. */
export function Header({ view, onNavigate, onOpenSettings, laterOpen, laterShut, onOpenLater, onCloseLater }: Props) {
  const { auth, signOut } = useAuth();
  // A key moves the focus to its button, as a click would have: the control it was on may go with the page.
  const brandButton = useRef<HTMLButtonElement>(null);
  const boardButton = useRef<HTMLButtonElement>(null);
  const historyButton = useRef<HTMLButtonElement>(null);
  const laterButton = useRef<HTMLButtonElement>(null);
  const onHistory = view === 'history';
  const onBoard = view === 'board';
  // Off the Board the button opens and closes the strip; open, it stays pressable at the cap, to close it.
  const stripOpen = !onBoard && laterOpen;
  const laterOff = laterShut && !stripOpen;
  const closeStrip = () => {
    laterButton.current?.focus({ preventScroll: true });
    onCloseLater();
  };
  const toLater = onBoard ? clickLaterAdd : onOpenLater;
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
  // With the strip open, L only puts the focus in its box, as Later's + does with an open box: a key that closed it would drop the text.
  const laterKey = useShortcut('later', laterOff ? null : toLater);
  const titled = (name: string, key: string | undefined) => (key ? `${name} (${key})` : name);

  return (
    <header className="topbar">
      <div className="topbar-row">
        <button ref={brandButton} className="brand" onClick={toToday} title={titled('Go to today', sheetKey)} aria-keyshortcuts={sheetKey}>
          <img src="/icons/icon.svg" alt="" width={28} height={28} />
          <span className="brand-name">Clockspan</span>
        </button>
        <div className="topbar-actions">
          <button
            ref={boardButton}
            id="header-board"
            className="btn btn-icon"
            onClick={toggleBoard}
            aria-pressed={onBoard}
            // Its words are hidden on a phone, where the title would name it, key and all.
            aria-label="Board"
            title={titled('Board', boardKey)}
            aria-keyshortcuts={boardKey}
          >
            <Columns />
            <span className="btn-text">Board</span>
          </button>
          <button
            ref={historyButton}
            className="btn btn-icon"
            onClick={toggleHistory}
            aria-pressed={onHistory}
            aria-label="History"
            title={titled('History', historyKey)}
            aria-keyshortcuts={historyKey}
          >
            <List />
            <span className="btn-text">History</span>
          </button>
          <button
            ref={laterButton}
            id="header-later"
            className="btn btn-icon"
            onClick={laterOff ? undefined : stripOpen ? closeStrip : toLater}
            // Pressed, it would blur an empty box, which closes the strip, and the click would open it again.
            onMouseDown={stripOpen ? (e) => e.preventDefault() : undefined}
            aria-expanded={onBoard ? undefined : laterOpen}
            aria-controls={stripOpen ? 'later-strip' : undefined}
            aria-disabled={laterOff || undefined}
            aria-label="Add to Later"
            title={titled('Add to Later', laterKey)}
            aria-keyshortcuts={laterKey}
          >
            <Inbox />
            <span className="btn-text">Add to Later</span>
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
              <span className="btn-text">Sign Out</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
