import { useModalDialog } from '../hooks/useModalDialog';
import { useTimer } from '../hooks/useTimer';
import { FINISH_CHOICE } from '../lib/copy';
import { formatDuration } from '../lib/format';

/**
 * Asked when Finish is pressed a whole minute or more past the timer's end: log the planned
 * length (the default: a timer that runs out unattended logs the same) or the time worked.
 * Mounted once in App; it renders nothing until the timer asks.
 */
export function FinishChoice() {
  const { finishChoice } = useTimer();
  return finishChoice ? <Choice /> : null;
}

function Choice() {
  const { running, elapsedSeconds, overrunSeconds, finish, dismissFinishChoice } = useTimer();
  // Same native modal as Settings: focus on the frame, so Enter can't fire a button before the question is seen.
  const dialog = useModalDialog(dismissFinishChoice);
  if (!running) return null;
  return (
    <dialog {...dialog} className="dialog finish-choice" aria-labelledby="finish-choice-title">
      <div className="dialog-inner">
        <header className="dialog-head">
          <h2 id="finish-choice-title">{FINISH_CHOICE.title}</h2>
        </header>
        <div className="dialog-body">
          <p className="muted">{FINISH_CHOICE.body(overrunSeconds >= 60 ? formatDuration(overrunSeconds) : null)}</p>
        </div>
        <footer className="dialog-foot">
          <button className="btn btn-primary" onClick={() => void finish()}>
            {FINISH_CHOICE.planned(formatDuration(running.plannedSeconds))}
          </button>
          <button className="btn" onClick={() => void finish(true)}>
            {FINISH_CHOICE.worked(formatDuration(elapsedSeconds))}
          </button>
          <button className="btn btn-ghost" onClick={dismissFinishChoice}>
            {FINISH_CHOICE.back}
          </button>
        </footer>
      </div>
    </dialog>
  );
}
