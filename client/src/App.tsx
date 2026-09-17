import { useCallback, useMemo, useState } from 'react';
import { AuthGate } from './auth/AuthGate';
import { Banners } from './components/Banners';
import { Header } from './components/Header';
import { History } from './components/History';
import { RunningTimerBar } from './components/RunningTimerBar';
import { SettingsDialog } from './components/SettingsDialog';
import { Sheet } from './components/Sheet';
import { useAlarms } from './hooks/useAlarms';
import { DayProvider, useDay } from './hooks/useDay';
import { useNow } from './hooks/useNow';
import { useRoute } from './hooks/useRoute';
import { useSettled } from './hooks/useSettled';
import { SettingsProvider, useSettings } from './hooks/useSettings';
import { TimerProvider, useTimer } from './hooks/useTimer';
import { todayKey } from './lib/format';
import { computeTimeclock } from './lib/timeclock';
import type { CardId } from './types';

export function App() {
  return (
    <AuthGate>
      <SettingsProvider>
        <DayProvider>
          <TimerProvider>
            <Shell />
          </TimerProvider>
        </DayProvider>
      </SettingsProvider>
    </AuthGate>
  );
}

function Shell() {
  const [route, navigate] = useRoute();
  const [customize, setCustomize] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [jumpTo, setJumpTo] = useState<CardId | null>(null);
  const { settings } = useSettings();
  const { running } = useTimer();
  const now = useNow(1000);

  // Alarms always watch *today*, whatever the sheet is showing. They wait while focus is
  // inside the punch rows and for a few seconds after it leaves, so back-filling a day
  // (clock in, think, lunch out) is judged on the finished set, not on each half-entered
  // state. A focused row means the user is at the card; nothing here is finer than a minute.
  const today = todayKey(now);
  const { day: todayDay, store } = useDay(today);
  const [editingPunches, setEditingPunches] = useState(false);
  const punches = useSettled(todayDay?.punches, 3000, editingPunches);
  const todayTc = useMemo(() => (punches ? computeTimeclock(punches, settings, now) : null), [punches, settings, now]);
  // A day flagged while the feature was on stays silent only while it is still on.
  const overtimeApproved = settings.overtimeApproval && Boolean(todayDay?.overtimeApproved);
  const approveOvertime = useCallback(() => void store.setOvertimeApproved(today, true), [store, today]);
  // The banner's button lands on today's sheet at the retrospective card, wherever the
  // user was when the alarm fired.
  const openRetro = useCallback(() => {
    navigate({ view: 'sheet', date: today });
    setJumpTo('retro');
  }, [navigate, today]);
  const onJumped = useCallback(() => setJumpTo(null), []);
  useAlarms(today, todayTc, settings, now, {
    overtimeApproved,
    retroDone: Boolean(todayDay?.retroAt),
    approveOvertime: settings.overtimeApproval ? approveOvertime : undefined,
    openRetro,
  });

  return (
    <div className={`app${running ? ' app--has-bar' : ''}`}>
      {running && <RunningTimerBar />}
      <Banners />
      <Header
        route={route}
        today={today}
        customize={customize}
        onNavigate={navigate}
        onToggleCustomize={() => setCustomize((c) => !c)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className="main">
        {route.view === 'sheet' ? (
          <Sheet date={route.date} today={today} now={now} customize={customize} jumpTo={jumpTo} onJumped={onJumped} onPunchEditing={setEditingPunches} />
        ) : (
          <History today={today} now={now} onOpen={(date) => navigate({ view: 'sheet', date })} />
        )}
      </main>
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
