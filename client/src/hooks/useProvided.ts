import { useContext, type Context } from 'react';

/** A context's value, for a hook that only works inside its provider (`name` is the hook's). */
export function useProvided<T>(ctx: Context<T | null>, name: string): T {
  const v = useContext(ctx);
  // `== null`, not `!v`: the clock's value is a number, and 0 is one.
  if (v == null) throw new Error(`${name} outside its provider`);
  return v;
}
