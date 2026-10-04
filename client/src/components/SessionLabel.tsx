import { UNTITLED_SESSION } from '../lib/copy';

/** A session's label, or a muted "Untitled session" when it has none. */
export function SessionLabel({ label }: { label: string }) {
  return label || <span className="muted">{UNTITLED_SESSION}</span>;
}
