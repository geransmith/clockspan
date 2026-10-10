import { useEffect, useRef, useState } from 'react';
import { CATEGORY_COLORS, LIMITS } from '../../../../shared/api.js';
import { SETTING_LIMITS } from '../../../../shared/settings.js';
import { categoryName } from '../../../../shared/text.js';
import { useBoardState, useBoardStore } from '../../hooks/useBoard';
import { useFollowedDraft } from '../../hooks/useFollowedDraft';
import type { Save } from '../../hooks/useSaveStatus';
import { activeCategories, categoryForName, categoryNameTaken, nextColor } from '../../lib/board';
import { BOARD, LOAD_FAILED } from '../../lib/copy';
import { newUid } from '../../lib/priorities';
import type { Category, CategoryColor } from '../../types';
import { CategoryDot } from '../CategoryDot';
import { ErrorLine } from '../ErrorLine';
import { LoadFailed } from '../LoadFailed';
import { NumberField, Section, type TabProps } from './controls';

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

/**
 * Settings → Board: the categories, each renamed, recoloured or removed in place, and Add
 * category; then how many recurring rows the morning offer ticks (a card is set to repeat on the
 * board). Each category change is a board write (`useBoard`) through the dialog's `save`, so it
 * shows at once and the header says whether it was saved. The board is read as the tab opens.
 */
export function BoardTab({ settings, set, save }: TabProps & { save: Save }) {
  const { board, failed } = useBoardState();
  const store = useBoardStore();
  useEffect(() => void store.load(), [store]);
  if (failed && !board) {
    return (
      <LoadFailed
        title={LOAD_FAILED.board}
        onRetry={() => {
          // Try Again goes once the board loads: the focus moves to the tab, the control before it.
          document.getElementById('tab-board')?.focus();
          void store.load();
        }}
      />
    );
  }
  if (!board) return <div className="loading" aria-busy="true" />;
  return (
    <>
      <Categories categories={board.categories} save={save} />
      <Section
        title="Recurring Priorities"
        hint="A card set to repeat on the board is offered on Top Priorities on its days. Nothing is added until you tap Add to Today."
      >
        <NumberField
          label="Recurring rows per day"
          unit="rows"
          {...SETTING_LIMITS.recurringPerDay}
          value={settings.recurringPerDay}
          hint="The morning offer ticks this many. You can tick more."
          onCommit={(n) => set({ recurringPerDay: n })}
        />
      </Section>
    </>
  );
}

function Categories({ categories, save }: { categories: Category[]; save: Save }) {
  const store = useBoardStore();
  const [adding, setAdding] = useState(false);
  const boxes = useRef(new Map<string, HTMLInputElement>());
  const addButton = useRef<HTMLButtonElement>(null);
  const boxRef = (uid: string) => (box: HTMLInputElement | null) => {
    if (box) boxes.current.set(uid, box);
    else boxes.current.delete(uid);
  };
  const inUse = activeCategories(categories);
  // A row goes with its Remove button, and the focus would fall to the page: the next row's box
  // takes it, else the one before, else Add Category.
  const remove = (uid: string) => {
    const at = inUse.findIndex((c) => c.uid === uid);
    const near = inUse[at + 1] ?? inUse[at - 1];
    (near ? boxes.current.get(near.uid) : addButton.current)?.focus();
    void save(() => store.removeCategory(uid));
  };
  return (
    <Section title="Categories" hint="Removing a category keeps it on past days.">
      {inUse.length === 0 && !adding && <p className="muted small">No categories yet.</p>}
      {inUse.map((c) => (
        <CategoryRow key={c.uid} category={c} categories={categories} save={save} onRemove={() => remove(c.uid)} nameRef={boxRef(c.uid)} />
      ))}
      {adding ? (
        <NewCategory categories={categories} save={save} onDone={() => setAdding(false)} />
      ) : (
        <div>
          <button ref={addButton} className="btn btn-ghost" onClick={() => setAdding(true)}>
            Add Category
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
  const [draft, setDraft] = useFollowedDraft(category.name);
  const [error, setError] = useState<string | null>(null);
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
 * The row Add Category opens, its name focused, its dot in the colour a new category gets. Enter
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
    setError(null);
    const made = categoryForName(categories, draft, newUid());
    if (!made) return true;
    if (!made.send) {
      setError(BOARD.nameTaken);
      return false;
    }
    const { send } = made;
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
          if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
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
