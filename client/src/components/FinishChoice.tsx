import { useId } from 'react';
import { useModalDialog } from '../hooks/useModalDialog';
import { useTimer } from '../hooks/useTimer';
import { FINISH_CHOICE } from '../lib/copy';
import { formatDuration } from '../lib/format';
import type { Session } from '../types';

/**
 * Asked when Finish is pressed after the timer ran out, once the planned and the worked length
 * differ in their whole minutes (`requestFinish`): log the planned
 * length (the default: a timer that runs out unattended logs the same) or the time worked.
 * Mounted once in App; it renders nothing until the timer asks.
 */
export function FinishChoice() {
  const { finishChoice } = useTimer();
  return finishChoice ? <Choice session={finishChoice} /> : null;
}

function Choice({ session }: { session: Session }) {
  const { elapsedSeconds, overrunSeconds, finish, dismissFinishChoice } = useTimer();
  // Same native modal as Settings: focus on the frame, so Enter can't fire a button before the question is seen.
  const dialog = useModalDialog(dismissFinishChoice);
  const titleId = useId();
  // The body says how far past the end it is, which decides the answer, so it is read with the title.
  const bodyId = useId();
  return (
    <dialog {...dialog} className="dialog finish-choice" aria-labelledby={titleId} aria-describedby={bodyId}>
      <div className="dialog-inner">
        <header className="dialog-head">
          <h2 id={titleId}>{FINISH_CHOICE.title}</h2>
        </header>
        <div className="dialog-body">
          <p id={bodyId} className="muted">
            {FINISH_CHOICE.body(overrunSeconds >= 60 ? formatDuration(overrunSeconds) : null)}
          </p>
        </div>
        <footer className="dialog-foot">
          <button className="btn btn-ghost" onClick={dismissFinishChoice}>
            {FINISH_CHOICE.back}
          </button>
          <button className="btn btn-primary" onClick={() => void finish()}>
            {FINISH_CHOICE.planned(formatDuration(session.plannedSeconds))}
          </button>
          <button className="btn" onClick={() => void finish(true)}>
            {FINISH_CHOICE.worked(formatDuration(elapsedSeconds))}
          </button>
        </footer>
      </div>
    </dialog>
  );
}
