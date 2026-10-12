import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { AuthGate } from './auth/AuthGate';
import { Banners } from './components/Banners';
import { Burst } from './components/Burst';
import { Header } from './components/Header';
import { LaterStrip } from './components/LaterStrip';
import { RunningTimerBar } from './components/RunningTimerBar';
import { FinishChoice } from './components/FinishChoice';
import { Shortcuts } from './components/Shortcuts';
import { Sheet } from './components/Sheet';
import { AppProviders } from './hooks/AppProviders';
import { useBoardState } from './hooks/useBoard';
import { useCelebration } from './hooks/useCelebration';
import { useBreak } from './hooks/useBreak';
import { useClock } from './hooks/useClock';
import { useLiveChanges } from './hooks/useLiveChanges';
import { useRoute } from './hooks/useRoute';
import { useSettings } from './hooks/useSettings';
import { useTabTitle } from './hooks/useTabTitle';
import { useTimer } from './hooks/useTimer';
import { useTodayAlarms } from './hooks/useTodayAlarms';
import { todayKey } from '../../shared/dates.js';
import { boardFull } from './lib/board';
import { floorToMinute } from './lib/format';
import { applyTheme } from './lib/theme';
import type { CardId } from './types';

// History, the board and the settings dialog load when first opened, so the sheet's first load
// goes without them. A chunk that fails to load (a deploy while the page was open) reloads the
// page from main.tsx.
const History = lazy(() => import('./components/History').then((m) => ({ default: m.History })));
const Board = lazy(() => import('./components/board/Board').then((m) => ({ default: m.Board })));
const SettingsDialog = lazy(() => import('./components/settings/SettingsDialog').then((m) => ({ default: m.SettingsDialog })));

export function App() {
  return (
    <AuthGate>
      <AppProviders>
        <Shell />
      </AppProviders>
    </AuthGate>
  );
}

function Shell() {
  const [route, navigate, openDay] = useRoute();
  const [customize, setCustomize] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [jumpTo, setJumpTo] = useState<CardId | null>(null);
  // Only whether the Later strip is open: its text, line and category are its own (LaterStrip).
  const [laterOpen, setLaterOpen] = useState(false);
  const laterBox = useRef<HTMLInputElement>(null);
  const { board } = useBoardState();
  const { settings, loaded } = useSettings();
  const { running, start, starting, ticked } = useTimer();
  const { start: startBreak } = useBreak();
  // Here, since the bar and the card Done is pressed on go with the session as it answers.
  const { burst } = useCelebration(ticked, 'priorityDone');
  const now = useClock();
  // Here rather than in AppProviders, which the hook and component tests render: happy-dom has no EventSource.
  useLiveChanges();
  // Only a real answer: the defaults' 'auto' would undo a forced theme main.tsx put up.
  useEffect(() => {
    if (loaded) applyTheme(settings.theme);
  }, [loaded, settings.theme]);

  const today = todayKey(now);
  // The route keeps today as null, so the sheet follows the date over midnight.
  const date = route.date ?? today;
  // The banner's button lands on today's sheet at the retrospective card, wherever the
  // user was when the alarm fired. Today is the null route, which follows the date, so a
  // `today` that lags the clock can't pin the sheet to yesterday.
  const openRetro = () => {
    navigate({ view: 'sheet', date: null });
    setJumpTo('retro');
  };
  const onJumped = useCallback(() => setJumpTo(null), []);
  // Stable, as the memoized sheet takes it.
  const toggleCustomize = useCallback(() => setCustomize((c) => !c), []);
  // History and the sheet show nothing finer than a minute. Handed the clock floored to the
  // minute (and memoized), they render once a minute instead of every second.
  const minute = floorToMinute(now);
  // The sheet on today and the board (once it is past the settings' wait) show today's failed load
  // in place; elsewhere a banner says it.
  const { setEditingPunches } = useTodayAlarms(today, now, openRetro, (route.view === 'board' && loaded) || (route.view === 'sheet' && date === today), {
    startBreak,
    timerStarting: starting,
  });
  useTabTitle(today, now);
  // The box takes the focus inside the tap, which is what lets iOS raise the keyboard; an open strip only takes the focus.
  const openLater = () => {
    flushSync(() => setLaterOpen(true));
    laterBox.current?.focus();
  };
  const closeLater = useCallback(() => setLaterOpen(false), []);
  const loading = <div className="loading" aria-busy="true" />;

  const page = () => {
    switch (route.view) {
      case 'sheet':
        return (
          <Sheet
            date={date}
            today={today}
            now={minute}
            customize={customize}
            onToggleCustomize={toggleCustomize}
            onNavigate={navigate}
            jumpTo={jumpTo}
            onJumped={onJumped}
            onPunchEditing={setEditingPunches}
          />
        );
      case 'history':
        return (
          <Suspense fallback={loading}>
            <History today={today} now={minute} date={date} review={route.review} onOpen={openDay} />
          </Suspense>
        );
      case 'board':
        // Until the settings answer, the defaults would draw the clock bar for someone who turned it off.
        return loaded ? (
          <Suspense fallback={loading}>
            <Board today={today} now={minute} running={running} start={start} starting={starting} />
          </Suspense>
        ) : (
          loading
        );
    }
  };

  return (
    <div className={`app${running ? ' app--has-bar' : ''}`}>
      <Header
        view={route.view}
        onNavigate={navigate}
        onOpenSettings={() => setSettingsOpen(true)}
        laterOpen={laterOpen}
        laterShut={!board || boardFull(board)}
        onOpenLater={openLater}
        onCloseLater={closeLater}
      />
      {/* The running bar, the Later strip and the banners, under the header and sticking to the top
          once it scrolls away; a child of .app, since a sticky box sticks only inside its parent.
          Always here: Banners is a live region. */}
      <div className="top-stack">
        {/* Keyed by session: one another device swapped in must not inherit an open label draft. */}
        {running && <RunningTimerBar key={running.id} session={running} />}
        {/* Hidden on the Board, whose Later has its own box, and kept, so its text is there on the way back. */}
        {laterOpen && <LaterStrip hidden={route.view === 'board'} inputRef={laterBox} onClose={closeLater} />}
        <Banners />
      </div>
      <main>{page()}</main>
      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsDialog onClose={() => setSettingsOpen(false)} />
        </Suspense>
      )}
      <FinishChoice />
      <Burst at={burst} />
      <Shortcuts />
    </div>
  );
}
