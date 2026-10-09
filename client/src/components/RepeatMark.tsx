import { Repeat } from './Icons';

/**
 * The mark beside a recurring priority's row, on the board's meta line and before a written
 * recurring row's category chip on the sheet. Kept out of `components/board/` so the sheet can
 * show it without the board's chunk.
 */
export function RepeatMark() {
  return (
    <span className="repeat-mark" role="img" aria-label="Repeats" title="Repeats">
      <Repeat />
    </span>
  );
}
