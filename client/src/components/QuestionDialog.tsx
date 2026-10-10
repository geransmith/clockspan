import { useId } from 'react';
import { useModalDialog } from '../hooks/useModalDialog';

interface Action {
  label: string;
  onClick: () => void;
}

/**
 * A question with two answers and a way back (`FinishChoice`, `RemoveTask`). Its parent shows it
 * by mounting it (`useModalDialog`).
 */
export function QuestionDialog({
  className,
  title,
  body,
  cancel,
  onCancel,
  primary,
  secondary,
}: {
  /** The dialog's own class beside `dialog`. */
  className: string;
  title: string;
  body: string;
  /** The way back's label. */
  cancel: string;
  /** The way back, Escape or a press outside: nothing changes. */
  onCancel: () => void;
  /** The default answer. */
  primary: Action;
  secondary: Action;
}) {
  // Same native modal as Settings: focus on the frame, so Enter can't fire a button before the question is read.
  const dialog = useModalDialog(onCancel);
  const titleId = useId();
  // The body holds what decides the answer, so it is read with the title.
  const bodyId = useId();
  return (
    <dialog {...dialog} className={`dialog ${className}`} aria-labelledby={titleId} aria-describedby={bodyId}>
      <div className="dialog-inner">
        <header className="dialog-head">
          <h2 id={titleId}>{title}</h2>
        </header>
        <div className="dialog-body">
          <p id={bodyId} className="muted">
            {body}
          </p>
        </div>
        <footer className="dialog-foot">
          <button className="btn btn-ghost" onClick={onCancel}>
            {cancel}
          </button>
          <button className="btn btn-primary" onClick={primary.onClick}>
            {primary.label}
          </button>
          <button className="btn" onClick={secondary.onClick}>
            {secondary.label}
          </button>
        </footer>
      </div>
    </dialog>
  );
}
