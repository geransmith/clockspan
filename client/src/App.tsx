import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { AuthGate } from './auth/AuthGate';
import { Banners } from './components/Banners';
import { Header } from './components/Header';
import { RunningTimerBar } from './components/RunningTimerBar';
import { FinishChoice } from './components/FinishChoice';
import { Shortcuts } from './components/Shortcuts';
import { Sheet } from './components/Sheet';
import { AppProviders } from './hooks/AppProviders';
import { useClock } from './hooks/useClock';
import { useRoute } from './hooks/useRoute';
import { useSettings } from './hooks/useSettings';
import { useTimer } from './hooks/useTimer';
import { useTodayAlarms } from './hooks/useTodayAlarms';
import { todayKey } from '../../shared/dates.js';
import { floorToMinute } from './lib/format';
import type { ReviewPeriod } from './lib/review';
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
  const [route, navigate] = useRoute();
  const [customize, setCustomize] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [jumpTo, setJumpTo] = useState<CardId | null>(null);
  const { settings, loaded } = useSettings();
  const { running, start, starting } = useTimer();
  const now = useClock();
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
  // History and the sheet show nothing finer than a minute. Handed the clock floored to the
  // minute (and memoized), they render once a minute instead of every second.
  const minute = floorToMinute(now);
  // The calendar's month and picked day are its own state and don't survive the unmount, so
  // the opened day is written onto the History entry first and Back reopens the calendar on
  // it. A day opened from Review records the period with it, so Back reopens the review
  // there.
  const openDay = useCallback(
    (d: string, review: ReviewPeriod | null) => {
      navigate({ date: d, review }, { replace: true });
      navigate({ view: 'sheet' });
    },
    [navigate],
  );
  const { setEditingPunches } = useTodayAlarms(today, now, openRetro);
  // A board link opened with the board off (switched off here or on another device) shows the sheet.
  const view = route.view === 'board' && loaded && !settings.board ? 'sheet' : route.view;
  const loading = <div className="loading" aria-busy="true" />;
  // With the board's class, so the page takes the board's width while its chunk and data load.
  const boardLoading = <div className="board loading" aria-busy="true" />;

  const page = () => {
    switch (view) {
      case 'sheet':
        return <Sheet date={date} today={today} now={minute} customize={customize} jumpTo={jumpTo} onJumped={onJumped} onPunchEditing={setEditingPunches} />;
      case 'history':
        return (
          <Suspense fallback={loading}>
            <History today={today} now={minute} date={date} review={route.review} onOpen={openDay} />
          </Suspense>
        );
      case 'board':
        // Until the settings answer, whether the board is on isn't known.
        return loaded ? (
          <Suspense fallback={boardLoading}>
            <Board today={today} now={minute} running={running} start={start} starting={starting} />
          </Suspense>
        ) : (
          boardLoading
        );
    }
  };

  return (
    <div className={`app${running ? ' app--has-bar' : ''}`}>
      {/* Keyed by session: one another device swapped in must not inherit an open label draft. */}
      {running && <RunningTimerBar key={running.id} session={running} />}
      <Banners />
      <Header
        view={view}
        date={date}
        today={today}
        board={settings.board}
        customize={customize}
        onNavigate={navigate}
        onToggleCustomize={() => setCustomize((c) => !c)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main>{page()}</main>
      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsDialog onClose={() => setSettingsOpen(false)} />
        </Suspense>
      )}
      <FinishChoice />
      <Shortcuts />
    </div>
  );
}
