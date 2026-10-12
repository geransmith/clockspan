import { WEEKDAYS } from '../lib/recurring';

/**
 * Seven day buttons, each pressed while its day is on: a recurring priority's on the board, and a
 * weekly meeting's on the Meetings card. The last day on stays on, and stays focusable, so what
 * repeats always has a day, unless `optional` (a new meeting's, where none is a one-off); Stop
 * Repeating ends it.
 */
export function RepeatDays({
  id,
  days,
  onDay,
  onStop,
  optional = false,
}: {
  id: string;
  days: readonly number[];
  /** A day pressed, with the button pressed, for a press that may take it away. */
  onDay: (day: number, on: boolean, pressed: HTMLButtonElement) => void;
  onStop?: (pressed: HTMLButtonElement) => void;
  optional?: boolean;
}) {
  return (
    <div className="repeat-days" role="group" aria-labelledby={id}>
      <span id={id} className="muted small">
        Repeat
      </span>
      <div className="weekdays">
        {WEEKDAYS.map(({ day, letter, name }) => {
          const on = days.includes(day);
          const last = !optional && on && days.length === 1;
          return (
            <button
              key={day}
              type="button"
              className="chip"
              onClick={(e) => {
                if (!last) onDay(day, !on, e.currentTarget);
              }}
              aria-pressed={on}
              aria-disabled={last || undefined}
              aria-label={name}
            >
              {letter}
            </button>
          );
        })}
      </div>
      {onStop && (
        <button className="btn btn-ghost" onClick={(e) => onStop(e.currentTarget)}>
          Stop Repeating
        </button>
      )}
    </div>
  );
}
