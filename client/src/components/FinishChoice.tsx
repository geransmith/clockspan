import { useTimer } from '../hooks/useTimer';
import { FINISH_CHOICE } from '../lib/copy';
import { formatDuration } from '../lib/format';
import { QuestionDialog } from './QuestionDialog';

/**
 * Asked when Finish or Done is pressed after the timer ran out, once the planned and the worked
 * length differ in their whole minutes (`requestFinish`, `requestDone`): log the planned
 * length (the default: a timer that runs out unattended logs the same) or the time worked.
 * Mounted once in App; it renders nothing until the timer asks.
 */
export function FinishChoice() {
  const { finishChoice, elapsedSeconds, overrunSeconds, finish, dismissFinishChoice } = useTimer();
  if (!finishChoice) return null;
  return (
    <QuestionDialog
      className="finish-choice"
      title={FINISH_CHOICE.title}
      body={FINISH_CHOICE.body(overrunSeconds >= 60 ? formatDuration(overrunSeconds) : null)}
      cancel={FINISH_CHOICE.back}
      onCancel={dismissFinishChoice}
      primary={{ label: FINISH_CHOICE.planned(formatDuration(finishChoice.plannedSeconds)), onClick: () => void finish() }}
      secondary={{ label: FINISH_CHOICE.worked(formatDuration(elapsedSeconds)), onClick: () => void finish(true) }}
    />
  );
}
