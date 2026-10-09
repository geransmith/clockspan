import { useId } from 'react';
import { useModalDialog } from '../hooks/useModalDialog';
import { REMOVE_TASK } from '../lib/copy';

interface Props {
  /** The task's name. */
  name: string;
  /** How many days besides this one hold it. */
  otherDays: number;
  /** The time logged on it, formatted; null with none. */
  logged: string | null;
  onOffDay: () => void;
  onEverywhere: () => void;
  /** Cancel, Escape or a press outside: nothing changes, and the focus goes back to the ×. */
  onCancel: () => void;
}

/**
 * Asked by × on a Top priorities row whose task is on other days or has time logged on it: take
 * it off this day, or delete it everywhere. `window.confirm` offers one action, so this is a
 * dialog. Its parent shows it by mounting it (`useModalDialog`).
 */
export function RemoveTask({ name, otherDays, logged, onOffDay, onEverywhere, onCancel }: Props) {
  // Focus on the frame, as in FinishChoice, so Enter can't fire a button before the question is read.
  const dialog = useModalDialog(onCancel);
  const titleId = useId();
  // The body holds what decides the answer, so it is read with the title.
  const bodyId = useId();
  return (
    <dialog {...dialog} className="dialog remove-task" aria-labelledby={titleId} aria-describedby={bodyId}>
      <div className="dialog-inner">
        <header className="dialog-head">
          <h2 id={titleId}>{REMOVE_TASK.title(name)}</h2>
        </header>
        <div className="dialog-body">
          <p id={bodyId} className="muted">
            {REMOVE_TASK.body(otherDays, logged)}
          </p>
        </div>
        <footer className="dialog-foot">
          <button className="btn btn-primary" onClick={onOffDay}>
            {REMOVE_TASK.offDay}
          </button>
          <button className="btn" onClick={onEverywhere}>
            {REMOVE_TASK.everywhere}
          </button>
          <button className="btn btn-ghost" onClick={onCancel}>
            {REMOVE_TASK.cancel}
          </button>
        </footer>
      </div>
    </dialog>
  );
}
