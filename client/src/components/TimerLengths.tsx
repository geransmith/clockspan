import { useSettings } from '../hooks/useSettings';
import { dismissByTag, unlockAudio } from '../lib/alerts';

/**
 * The focus timer's length buttons, on the timer card and a board card's dialog: the lengths the
 * settings give, shortest first, a length set twice once. The tap unlocks the sound before
 * `onStart`, since iOS counts only the tap as the gesture and a start may wait on a save first
 * (a new name's row, a board pull). It also takes the break banners down: their Start Break
 * goes out on the day store's queue, not the timer's, and the disabled buttons don't reach it.
 */
export function TimerLengths({ onStart, disabled }: { onStart: (minutes: number) => void; disabled: boolean }) {
  const { settings } = useSettings();
  const lengths = [...new Set(settings.timerMinutes)].sort((a, b) => a - b);
  const tap = (minutes: number) => {
    unlockAudio();
    dismissByTag('break');
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
