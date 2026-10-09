/**
 * The running session's pill: on its row in the day log, and first on the meta line of the board
 * item it runs on, where `id` lets the title name it. Kept out of `components/board/` so the sheet
 * can show it without the board's chunk.
 */
export function RunningMark({ paused, id }: { paused: boolean; id?: string }) {
  return (
    <span id={id} className={`pill ${paused ? 'pill--warn' : 'pill--ok'}`}>
      {paused ? 'paused' : 'running'}
    </span>
  );
}
