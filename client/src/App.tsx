import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { AuthGate } from './auth/AuthGate';
import { Banners } from './components/Banners';
import { Header } from './components/Header';
import { RunningTimerBar } from './components/RunningTimerBar';
import { FinishChoice } from './components/FinishChoice';
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

// History and the settings dialog load when first opened, so the sheet's first load goes
// without them. A chunk that fails to load (a deploy while the page was open) reloads the
// page from main.tsx.
const History = lazy(() => import('./components/History').then((m) => ({ default: m.History })));
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
  const { running } = useTimer();
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
  const openRetro = useCallback(() => {
    navigate({ view: 'sheet', date: null });
    setJumpTo('retro');
  }, [navigate]);
  const onJumped = useCallback(() => setJumpTo(null), []);
  // History shows nothing finer than a minute. Handed the clock floored to the minute (and
  // memoized), it renders once a minute instead of redoing the month or quarter every second.
  const minute = floorToMinute(now);
  // The calendar's month and picked day are its own state and don't survive the unmount, so
  // the opened day is written onto the History entry first and Back reopens the calendar on
  // it. A day opened from Review records the period with it, so Back reopens the review
  // there. The second call names both fields: navigate reads the route through useLatest,
  // which isn't updated between two calls in one handler.
  const openDay = useCallback(
    (d: string, review: ReviewPeriod | null) => {
      navigate({ date: d, review }, { replace: true });
      navigate({ view: 'sheet', date: d });
    },
    [navigate],
  );
  const { setEditingPunches } = useTodayAlarms(today, now, openRetro);

  return (
    <div className={`app${running ? ' app--has-bar' : ''}`}>
      {running && <RunningTimerBar />}
      <Banners />
      <Header
        view={route.view}
        date={date}
        today={today}
        customize={customize}
        onNavigate={navigate}
        onToggleCustomize={() => setCustomize((c) => !c)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className="main">
        {route.view === 'sheet' ? (
          <Sheet date={date} today={today} now={now} customize={customize} jumpTo={jumpTo} onJumped={onJumped} onPunchEditing={setEditingPunches} />
        ) : (
          <Suspense fallback={<div className="sheet-loading" aria-busy="true" />}>
            <History today={today} now={minute} date={date} review={route.review} onOpen={openDay} />
          </Suspense>
        )}
      </main>
      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsDialog onClose={() => setSettingsOpen(false)} />
        </Suspense>
      )}
      <FinishChoice />
    </div>
  );
}
