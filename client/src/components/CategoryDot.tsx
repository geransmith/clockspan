import type { CategoryColor } from '../types';

/**
 * A category's colour as a small dot beside its name: there are eight colours and no limit on
 * categories, so two can share one. Drawn from `data-color` (styles.css), never an inline
 * colour. The one drawn alone is the day log's, before a session's label: it takes the name as
 * `label`, read out by a screen reader and shown on hover.
 */
export function CategoryDot({ color, label }: { color: CategoryColor; label?: string }) {
  return label ? (
    <span className="cat-dot" data-color={color} role="img" aria-label={label} title={label} />
  ) : (
    <span className="cat-dot" data-color={color} aria-hidden="true" />
  );
}
