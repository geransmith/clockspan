import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { AuthGate } from './auth/AuthGate';
import { Banners } from './components/Banners';
import { Burst } from './components/Burst';
import { Header } from './components/Header';
import { RunningTimerBar } from './components/RunningTimerBar';
import { FinishChoice } from './components/FinishChoice';
import { Shortcuts } from './components/Shortcuts';
import { Sheet } from './components/Sheet';
import { AppProviders } from './hooks/AppProviders';
import { useCelebration } from './hooks/useCelebration';
import { useClock } from './hooks/useClock';
import { useLiveChanges } from './hooks/useLiveChanges';
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
  const { running, start, starting, ticked } = useTimer();
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
  // The sheet on today and the board show today's failed load in place; elsewhere a banner says it.
  const { setEditingPunches } = useTodayAlarms(today, now, openRetro, route.view === 'board' || (route.view === 'sheet' && date === today));
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
      <Header view={route.view} onNavigate={navigate} onOpenSettings={() => setSettingsOpen(true)} />
      {/* Under the header and sticking to the top once it scrolls away; a child of .app, since a sticky
          box sticks only inside its parent. Always here: Banners is a live region. */}
      <div className="top-stack">
        {/* Keyed by session: one another device swapped in must not inherit an open label draft. */}
        {running && <RunningTimerBar key={running.id} session={running} />}
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
