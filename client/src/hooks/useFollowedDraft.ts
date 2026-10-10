import { useState } from 'react';

/**
 * A text box's draft of a stored name or number (as text): typed freely, and put back to the stored name whenever that
 * changes, so a rename that landed, here or on another device, shows in the box. The draft is
 * adjusted while rendering, not in an effect, so the box never shows the old name for a frame.
 */
export function useFollowedDraft(stored: string): [string, (draft: string) => void] {
  const [draft, setDraft] = useState(stored);
  const [seen, setSeen] = useState(stored);
  if (stored !== seen) {
    setSeen(stored);
    setDraft(stored);
  }
  return [draft, setDraft];
}
