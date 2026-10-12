/** A failure under a form or a card, read out as soon as it appears. */
export function ErrorLine({ error, id }: { error: string | null; id?: string }) {
  return error ? (
    <p id={id} className="error" role="alert">
      {error}
    </p>
  ) : null;
}
