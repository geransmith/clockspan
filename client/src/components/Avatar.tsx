export function Avatar({ name }: { name: string }) {
  // The first grapheme, so a flag, a skin-toned or a joined emoji keeps its whole glyph.
  const [first] = new Intl.Segmenter().segment(name);
  return (
    <span className="avatar" aria-hidden="true">
      {(first?.segment ?? '').toUpperCase()}
    </span>
  );
}
