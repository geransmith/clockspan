import { useCallback, useState } from 'react';
import { addToDaySet, readDaySet, USER_KEYS } from '../lib/storage';

const NONE: ReadonlySet<string> = new Set();

/**
 * The recurring priorities the morning offer was answered for today on this device (Add to today
 * or Not today, ticked or not), kept in `USER_KEYS.recurringAnswered` so a reload doesn't offer
 * them again. Per device, as Start fresh is: another device still offers them. Read once; the set
 * is today's only, so a sheet left open over midnight starts the new day with none. An answer is
 * added to what is stored when it is given (`addToDaySet`), so another tab's answers stay.
 */
export function useRecurringAnswered(today: string): { answered: ReadonlySet<string>; answer: (uids: string[]) => void } {
  const [stored, setStored] = useState(() => ({ date: today, set: readDaySet(USER_KEYS.recurringAnswered, today) }));
  const answered = stored.date === today ? stored.set : NONE;
  const answer = useCallback(
    (uids: string[]) => setStored({ date: today, set: addToDaySet(USER_KEYS.recurringAnswered, today, [...answered, ...uids]) }),
    [answered, today],
  );
  return { answered, answer };
}
