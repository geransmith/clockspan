import { useSettings } from '../hooks/useSettings';
import { useTimer } from '../hooks/useTimer';
import { CONFIRM } from '../lib/copy';
import { Check, Minus, Pause, Play, Plus, X } from './Icons';

/**
 * The running timer's buttons, for the bar at the top (`compact`) and for the timer card: −/+
 * move the planned end by the adjust step, Pause and Resume hold the clock, Finish asks how much
 * to log once the timer ran a minute over, and Cancel asks first. Once due, only + and Finish
 * are left; + is off at the longest plan the server takes. The bar shows the icons and hides
 * the words on a narrow screen, so there each button carries its name.
 */
export function TimerControls({ compact = false }: { compact?: boolean }) {
  const { paused, due, canAdd, adjust, pause, resume, requestFinish, cancel } = useTimer();
  const { settings } = useSettings();
  const step = settings.adjustStepMinutes;
  const btn = compact ? 'btn btn-icon' : 'btn';
  const words = (text: string) => (compact ? <span className="btn-text">{text}</span> : ` ${text}`);
  const named = (name: string, title: string) => (compact ? { 'aria-label': name, title } : {});
  const onCancel = () => {
    if (window.confirm(CONFIRM.cancelSession)) void cancel();
  };

  return (
    <div className={compact ? 'running-controls' : 'timer-controls'}>
      {!due && (
        <button className={btn} onClick={() => void adjust(-step * 60)} {...named(`Remove ${step} minutes`, `−${step}m`)}>
          <Minus />
          {words(`${step}m`)}
        </button>
      )}
      <button className={btn} onClick={() => void adjust(step * 60)} disabled={!canAdd} {...named(`Add ${step} minutes`, `+${step}m`)}>
        <Plus />
        {words(`${step}m`)}
      </button>
      {!due &&
        (paused ? (
          <button className={btn} onClick={() => void resume()} {...named('Resume timer', 'Resume')}>
            <Play />
            {words('Resume')}
          </button>
        ) : (
          <button className={btn} onClick={() => void pause()} {...named('Pause timer', 'Pause')}>
            <Pause />
            {words('Pause')}
          </button>
        ))}
      <button className={`${btn} btn-primary`} onClick={requestFinish} title={compact ? 'Finish now' : undefined}>
        <Check />
        {words('Finish')}
      </button>
      {compact ? (
        <button className="btn btn-icon running-cancel" onClick={onCancel} aria-label="Cancel session" title="Cancel">
          <X />
        </button>
      ) : (
        <button className="btn btn-ghost" onClick={onCancel}>
          <X /> Cancel
        </button>
      )}
    </div>
  );
}
