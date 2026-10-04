export function Avatar({ name }: { name: string }) {
  // The first code point, not the first UTF-16 unit, so an initial that is an emoji is never half a surrogate pair.
  return (
    <span className="avatar" aria-hidden="true">
      {(Array.from(name)[0] ?? '').toUpperCase()}
    </span>
  );
}
