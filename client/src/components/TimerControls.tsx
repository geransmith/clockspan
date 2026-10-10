import { useSettings } from '../hooks/useSettings';
import { useShortcut } from '../hooks/useShortcuts';
import { useTimer } from '../hooks/useTimer';
import { CONFIRM } from '../lib/copy';
import { Check, Minus, Pause, Play, Plus, X } from './Icons';

/**
 * The running timer's buttons, for the bar at the top (`compact`) and for the timer card: −/+
 * move the planned end by the adjust step, Pause and Resume hold the clock, Finish asks how much
 * to log once the timer ran a minute over, and Cancel asks first. Once due, − and Pause go while
 * +, Finish and Cancel stay; + is off at the longest plan the server takes. The bar shows the
 * icons and hides the words on a narrow screen, so there each button carries its name. − and +
 * carry theirs on the card too: the icons are hidden from screen readers and both say only the
 * step. Keys: P pauses or resumes, + adds the step, and F finishes only once time's up, so a
 * stray F can't end a session early; − has none. On the card, `takeFocus` lets the first of Pause,
 * Resume and Finish to mount take the focus a start from the card handed on.
 */
export function TimerControls({ compact = false, takeFocus }: { compact?: boolean; takeFocus?: (el: HTMLElement | null) => void }) {
  const { paused, due, canAdd, adjust, pause, resume, requestFinish, cancel } = useTimer();
  const { settings } = useSettings();
  const step = settings.adjustStepMinutes;
  const btn = compact ? 'btn btn-icon' : 'btn';
  const words = (text: string) => (compact ? <span className="btn-text">{text}</span> : ` ${text}`);
  const named = (name: string, title: string) => (compact ? { 'aria-label': name, title } : {});
  const onCancel = () => {
    if (window.confirm(CONFIRM.cancelSession)) void cancel();
  };
  const onMore = () => void adjust(step * 60);
  const onPause = () => void (paused ? resume() : pause());
  const moreKey = useShortcut('more', canAdd ? onMore : null);
  const pauseKey = useShortcut('pause', due ? null : onPause);
  const finishKey = useShortcut('finish', due ? requestFinish : null);

  return (
    <div className={compact ? 'running-controls' : 'timer-controls'}>
      {!due && (
        <button className={btn} onClick={() => void adjust(-step * 60)} aria-label={`Remove ${step} minutes`} title={compact ? `−${step}m` : undefined}>
          <Minus />
          {words(`${step}m`)}
        </button>
      )}
      <button
        className={btn}
        onClick={onMore}
        disabled={!canAdd}
        aria-label={`Add ${step} minutes`}
        aria-keyshortcuts={moreKey}
        title={compact ? `+${step}m` : undefined}
      >
        <Plus />
        {words(`${step}m`)}
      </button>
      {!due &&
        (paused ? (
          <button className={btn} onClick={onPause} aria-keyshortcuts={pauseKey} {...named('Resume timer', 'Resume')} ref={takeFocus}>
            <Play />
            {words('Resume')}
          </button>
        ) : (
          <button className={btn} onClick={onPause} aria-keyshortcuts={pauseKey} {...named('Pause timer', 'Pause')} ref={takeFocus}>
            <Pause />
            {words('Pause')}
          </button>
        ))}
      <button className={`${btn} btn-primary`} onClick={requestFinish} aria-keyshortcuts={finishKey} {...named('Finish timer', 'Finish now')} ref={takeFocus}>
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
