import type { CategoryColor } from '../types';

/**
 * A category's colour as a small dot, always beside its name: there are eight colours and no
 * limit on categories, so two can share one. Drawn from `data-color` (styles.css), never an
 * inline colour.
 */
export function CategoryDot({ color }: { color: CategoryColor }) {
  return <span className="cat-dot" data-color={color} aria-hidden="true" />;
}
