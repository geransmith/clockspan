export function Avatar({ name }: { name: string }) {
  // The first code point, not the first UTF-16 unit, so a name that starts with an emoji shows it whole.
  return (
    <span className="avatar" aria-hidden="true">
      {(Array.from(name)[0] ?? '').toUpperCase()}
    </span>
  );
}
