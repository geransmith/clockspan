import { useCallback, useRef, useState, type SubmitEvent } from 'react';

/**
 * A form that sends a request: `onSubmit(send)` is the form's handler. It sends one at a time
 * (a second press while one is out does nothing, and `busy` disables the button), clears the
 * last error when it starts, and shows the message of whatever `send` throws, so `send`
 * refuses by throwing too (a confirmation that doesn't match). `setError` is for failures
 * outside the form that share its error line.
 */
export function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const out = useRef(false);
  const onSubmit = useCallback(
    (send: () => Promise<void>) => (e: SubmitEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (out.current) return;
      out.current = true;
      setBusy(true);
      setError(null);
      void send()
        .catch((err: unknown) => setError((err as Error).message))
        .finally(() => {
          out.current = false;
          setBusy(false);
        });
    },
    [],
  );
  return { busy, error, setError, onSubmit };
}
