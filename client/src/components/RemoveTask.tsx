import { REMOVE_TASK } from '../lib/copy';
import { QuestionDialog } from './QuestionDialog';

interface Props {
  /** The task's name. */
  name: string;
  /** How many days besides this one hold it. */
  otherDays: number;
  /** The time logged on it, formatted; null with none. */
  logged: string | null;
  /** It has a note, which goes with it. */
  note: boolean;
  onOffDay: () => void;
  onEverywhere: () => void;
  /** Cancel, Escape or a press outside: nothing changes, and the focus goes back to the ×. */
  onCancel: () => void;
}

/**
 * Asked by × on a Top Priorities row whose task is on other days, has time logged on it or has a
 * note: take it off this day, or delete it everywhere. `window.confirm` offers one action, so this
 * is a dialog. Its parent shows it by mounting it.
 */
export function RemoveTask({ name, otherDays, logged, note, onOffDay, onEverywhere, onCancel }: Props) {
  return (
    <QuestionDialog
      className="remove-task"
      title={REMOVE_TASK.title(name)}
      body={REMOVE_TASK.body(otherDays, logged, note)}
      cancel={REMOVE_TASK.cancel}
      onCancel={onCancel}
      primary={{ label: REMOVE_TASK.offDay, onClick: onOffDay }}
      secondary={{ label: REMOVE_TASK.everywhere, onClick: onEverywhere }}
    />
  );
}
