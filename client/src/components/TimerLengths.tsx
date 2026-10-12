import { useSettings } from '../hooks/useSettings';
import { ALARM_TAG } from '../lib/alarms';
import { dismissByTag, offerNotifications, unlockAudio } from '../lib/alerts';

/**
 * The focus timer's length buttons, on the timer card and a board card's dialog: the lengths the
 * settings give, shortest first, a length set twice once. The tap unlocks the sound and asks for
 * notifications (once per device, `offerNotifications`) before `onStart`, since iOS and Safari
 * count only the tap as the gesture and a start may wait on a save first (a new name's row, a
 * board pull). It also takes the break banners and the break alarm's banner down: their Start
 * Break goes out on the day store's queue, not the timer's, and the disabled buttons don't reach it.
 * The tap also takes the timer's ending banners down (`'timer-complete'`), so the stack clears from
 * the tap rather than only once the start answers.
 */
export function TimerLengths({ onStart, disabled }: { onStart: (minutes: number) => void; disabled: boolean }) {
  const { settings, loaded } = useSettings();
  const lengths = [...new Set(settings.timerMinutes)].sort((a, b) => a - b);
  const tap = (minutes: number) => {
    unlockAudio();
    offerNotifications(loaded && settings.notifications);
    dismissByTag('break');
    dismissByTag(ALARM_TAG + 'noBreak');
    dismissByTag('timer-complete');
    onStart(minutes);
  };
  return (
    <div className="timer-quick">
      {lengths.map((m) => (
        <button key={m} className="btn btn-quick" onClick={() => tap(m)} disabled={disabled}>
          <span className="timer-quick-num">{m}</span>
          <span className="timer-quick-unit">min</span>
        </button>
      ))}
    </div>
  );
}
