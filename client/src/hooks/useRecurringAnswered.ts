import { useCallback, useMemo, useState } from 'react';
import { readAnswered, writeAnswered } from '../lib/recurring';
import { readStored, USER_KEYS, writeStored } from '../lib/storage';

/**
 * The recurring priorities the morning offer was answered for today on this device (Add to today
 * or Not today, ticked or not), kept in `USER_KEYS.recurringAnswered` so a reload doesn't offer
 * them again. Per device, as Start fresh is: another device still offers them. Read once; the set
 * is today's only, so a sheet left open over midnight starts the new day with none. An answer is
 * added to what is stored when it is given, not to the copy read at mount: another tab or window
 * of this browser shares the key, and its answers stay.
 */
export function useRecurringAnswered(today: string): { answered: ReadonlySet<string>; answer: (uids: string[]) => void } {
  const [raw, setRaw] = useState(() => readStored(USER_KEYS.recurringAnswered));
  const answered = useMemo(() => readAnswered(raw, today), [raw, today]);
  const answer = useCallback(
    (uids: string[]) => {
      const next = writeAnswered(today, [...readAnswered(readStored(USER_KEYS.recurringAnswered), today), ...answered, ...uids]);
      writeStored(USER_KEYS.recurringAnswered, next);
      setRaw(next);
    },
    [answered, today],
  );
  return { answered, answer };
}
