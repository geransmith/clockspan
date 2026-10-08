import { Repeat } from './Icons';

/**
 * The mark beside a row added from a recurring priority, on the board's meta line. Kept out of
 * `components/board/` so the sheet can show it without the board's chunk.
 */
export function RepeatMark() {
  return (
    <span className="repeat-mark" role="img" aria-label="Repeats" title="Repeats">
      <Repeat />
    </span>
  );
}
