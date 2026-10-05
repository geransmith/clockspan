import { useRef, useState, type SubmitEvent } from 'react';

/**
 * A form or button that sends a request: `run(send)` sends, and `onSubmit(send)` is a form's
 * handler for the same. It sends one at a time (a second press while one is out does nothing,
 * and `busy` disables the button), clears the last error when it starts, and shows the message
 * of whatever `send` throws, so `send` refuses by throwing too (a confirmation that doesn't
 * match). `setError` is for failures outside the send that share its error line.
 */
export function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const out = useRef(false);
  const run = (send: () => Promise<void>) => {
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
  };
  const onSubmit = (send: () => Promise<void>) => (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    run(send);
  };
  return { busy, error, setError, run, onSubmit };
}
