import { useEffect, useRef, useState } from 'react';
import { CATEGORY_COLORS, LIMITS } from '../../../../shared/api.js';
import { categoryName } from '../../../../shared/text.js';
import { useBoardState, useBoardStore } from '../../hooks/useBoard';
import { activeCategories, categoryForName, categoryNameTaken, nextColor } from '../../lib/board';
import { BOARD, LOAD_FAILED } from '../../lib/copy';
import { newUid } from '../../lib/priorities';
import type { Category, CategoryColor } from '../../types';
import { CategoryDot } from '../CategoryDot';
import { ErrorLine } from '../ErrorLine';
import { LoadFailed } from '../LoadFailed';
import { Section } from './controls';

const COLOR_NAMES: Record<CategoryColor, string> = {
  blue: 'Blue',
  teal: 'Teal',
  green: 'Green',
  gold: 'Gold',
  orange: 'Orange',
  pink: 'Pink',
  purple: 'Purple',
  grey: 'Grey',
};

/** The dialog's save: the header says Saving…, Saved or Not saved for each board write. */
type Save = (run: () => Promise<void>) => Promise<void>;

/**
 * Settings → Board, shown while the board is on: the categories, each renamed, recoloured or
 * removed in place, and Add category. Each change is a board write (`useBoard`) through the
 * dialog's `save`, so it shows at once and the header says whether it was saved. The board is
 * read as the tab opens.
 */
export function BoardTab({ save }: { save: Save }) {
  const { board, failed } = useBoardState();
  const store = useBoardStore();
  useEffect(() => void store.load(), [store]);
  if (failed && !board) return <LoadFailed title={LOAD_FAILED.board} onRetry={() => void store.load()} />;
  if (!board) return <div className="sheet-loading" aria-busy="true" />;
  return <Categories categories={board.categories} save={save} />;
}

function Categories({ categories, save }: { categories: Category[]; save: Save }) {
  const store = useBoardStore();
  const [adding, setAdding] = useState(false);
  const nameBoxes = useRef(new Map<string, HTMLInputElement>());
  const addButton = useRef<HTMLButtonElement>(null);
  const inUse = activeCategories(categories);
  // The row goes with its Remove button, and the focus would fall to the page: the next row's
  // name takes it, else the one before, else Add category.
  const remove = (uid: string) => {
    const at = inUse.findIndex((c) => c.uid === uid);
    const near = inUse[at + 1] ?? inUse[at - 1];
    (near ? nameBoxes.current.get(near.uid) : addButton.current)?.focus();
    void save(() => store.removeCategory(uid));
  };
  return (
    <Section title="Categories" hint="Removing a category keeps it on past days.">
      {inUse.length === 0 && !adding && <p className="muted small">No categories yet.</p>}
      {inUse.map((c) => (
        <CategoryRow
          key={c.uid}
          category={c}
          categories={categories}
          save={save}
          onRemove={() => remove(c.uid)}
          nameRef={(box) => {
            if (box) nameBoxes.current.set(c.uid, box);
            else nameBoxes.current.delete(c.uid);
          }}
        />
      ))}
      {adding ? (
        <NewCategory categories={categories} save={save} onDone={() => setAdding(false)} />
      ) : (
        <div>
          <button ref={addButton} className="btn btn-ghost" onClick={() => setAdding(true)}>
            Add category
          </button>
        </div>
      )}
    </Section>
  );
}

/**
 * A category in use: its name (saved on blur or Enter, unless another category in use has it),
 * its colour as eight swatches (radios, so the arrow keys move along them, each move saved), and
 * Remove, which archives it with no confirm: nothing is lost.
 */
function CategoryRow({
  category,
  categories,
  save,
  onRemove,
  nameRef,
}: {
  category: Category;
  categories: Category[];
  save: Save;
  onRemove: () => void;
  nameRef: (box: HTMLInputElement | null) => void;
}) {
  const store = useBoardStore();
  const [draft, setDraft] = useState(category.name);
  const [seen, setSeen] = useState(category.name);
  const [error, setError] = useState<string | null>(null);
  // A rename that landed, here or on another device, shows in the box.
  if (category.name !== seen) {
    setSeen(category.name);
    setDraft(category.name);
  }
  const name = categoryName(draft);
  const taken = categoryNameTaken(categories, name, category.uid);
  const commit = () => {
    if (taken) {
      setError(BOARD.nameTaken);
    } else if (!name || name === category.name) {
      setDraft(category.name);
      setError(null);
    } else {
      setError(null);
      void save(() => store.editCategory(category.uid, { name }));
    }
  };
  return (
    <div className="category-row">
      <input
        ref={nameRef}
        className="input category-name"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
          // Leaving the box commits the name. A name in use keeps the focus, to be fixed where it is.
          if (taken) setError(BOARD.nameTaken);
          else e.currentTarget.blur();
        }}
        maxLength={LIMITS.categoryName}
        aria-label={`Name of ${category.name}`}
        aria-invalid={error ? true : undefined}
      />
      <div className="swatches" role="radiogroup" aria-label={`Colour of ${category.name}`}>
        {CATEGORY_COLORS.map((color) => (
          <label key={color} className="swatch">
            <input
              type="radio"
              name={`colour-${category.uid}`}
              checked={category.color === color}
              onChange={() => void save(() => store.editCategory(category.uid, { color }))}
              aria-label={COLOR_NAMES[color]}
            />
            <CategoryDot color={color} />
          </label>
        ))}
      </div>
      <button className="btn btn-ghost" onClick={onRemove} aria-label={`Remove ${category.name}`}>
        Remove
      </button>
      <ErrorLine error={error} />
    </div>
  );
}

/**
 * The row Add category opens, its name focused, its dot in the colour a new category gets. Enter
 * adds the category and leaves an empty row for the next; the focus leaving adds what is typed,
 * or closes the row when nothing is. A name in use stays in the box with the line saying so; a
 * removed category's name brings it back (`categoryForName`).
 */
function NewCategory({ categories, save, onDone }: { categories: Category[]; save: Save; onDone: () => void }) {
  const store = useBoardStore();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  // True when the category went out (or the box was blank), so the box can be emptied or closed.
  const add = () => {
    const made = categoryForName(categories, draft, newUid());
    if (!made) return true;
    if (!made.send) {
      setError(BOARD.nameTaken);
      return false;
    }
    const { send } = made;
    setError(null);
    void save(() => store.addCategory(send));
    return true;
  };
  return (
    <div className="category-row">
      <input
        className="input category-name"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (add()) onDone();
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.nativeEvent.isComposing || !draft.trim()) return;
          if (add()) setDraft('');
        }}
        maxLength={LIMITS.categoryName}
        placeholder="Category name"
        aria-label="New category"
        aria-invalid={error ? true : undefined}
        autoFocus
      />
      <CategoryDot color={nextColor(categories)} />
      <ErrorLine error={error} />
    </div>
  );
}
