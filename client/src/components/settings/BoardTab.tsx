import { useEffect, useRef, useState } from 'react';
import { CATEGORY_COLORS, LIMITS } from '../../../../shared/api.js';
import { SETTING_LIMITS } from '../../../../shared/settings.js';
import { categoryName } from '../../../../shared/text.js';
import type { RecurringPatch } from '../../api';
import { useBoardState, useBoardStore, useCategoryPick } from '../../hooks/useBoard';
import { activeCategories, categoryForName, categoryNameTaken, nextColor, type CategoryPick } from '../../lib/board';
import { BOARD, LOAD_FAILED } from '../../lib/copy';
import { newUid } from '../../lib/priorities';
import type { Category, CategoryColor, Recurring } from '../../types';
import { CategoryChip } from '../CategoryChip';
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

/** A recurring priority's days as the server numbers them (ISO, Monday 1), each a one-letter chip named in full. */
const WEEKDAYS = [
  { day: 1, letter: 'M', name: 'Monday' },
  { day: 2, letter: 'T', name: 'Tuesday' },
  { day: 3, letter: 'W', name: 'Wednesday' },
  { day: 4, letter: 'T', name: 'Thursday' },
  { day: 5, letter: 'F', name: 'Friday' },
  { day: 6, letter: 'S', name: 'Saturday' },
  { day: 7, letter: 'S', name: 'Sunday' },
] as const;

/** The dialog's save: the header says Saving…, Saved or Not saved for each board write. */
type Save = (run: () => Promise<void>) => Promise<void>;

/**
 * Settings → Board, shown while the board is on: the categories, each renamed, recoloured or
 * removed in place, and Add category; then the recurring priorities, each renamed, given a
 * category or other days, or removed in place, Add recurring priority, and how many recurring
 * rows the morning offer ticks. Each board change is a board write (`useBoard`) through the
 * dialog's `save`, so it shows at once and the header says whether it was saved, a category made
 * from a recurring priority's chip included. The board is read as the tab opens.
 */
export function BoardTab({ settings, set, save }: TabProps & { save: Save }) {
  const { board, failed } = useBoardState();
  const store = useBoardStore();
  const pick = useCategoryPick((saved) => void save(() => saved));
  useEffect(() => void store.load(), [store]);
  if (failed && !board) return <LoadFailed title={LOAD_FAILED.board} onRetry={() => void store.load()} />;
  if (!board) return <div className="sheet-loading" aria-busy="true" />;
  return (
    <>
      <Categories categories={board.categories} save={save} />
      <Section title="Recurring priorities" hint="Offered on Top priorities on these days. Nothing is added until you tap Add to today.">
        <NumberField
          label="Recurring rows per day"
          unit="rows"
          {...SETTING_LIMITS.recurringPerDay}
          value={settings.recurringPerDay}
          hint="The morning offer ticks this many. You can tick more."
          onCommit={(n) => set({ recurringPerDay: n })}
        />
        <RecurringList items={board.recurring} pick={pick} save={save} />
      </Section>
    </>
  );
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

/**
 * The recurring priorities in the order they were made, and Add recurring priority, always
 * offered: the server's cap of 100 shows only as Not saved.
 */
function RecurringList({ items, pick, save }: { items: Recurring[]; pick: CategoryPick | null; save: Save }) {
  const store = useBoardStore();
  const [adding, setAdding] = useState(false);
  const titleBoxes = useRef(new Map<string, HTMLInputElement>());
  const addButton = useRef<HTMLButtonElement>(null);
  // As with a category: the next row's title takes the focus, else the one before, else Add.
  const remove = (uid: string) => {
    const at = items.findIndex((r) => r.uid === uid);
    const near = items[at + 1] ?? items[at - 1];
    (near ? titleBoxes.current.get(near.uid) : addButton.current)?.focus();
    void save(() => store.removeRecurring(uid));
  };
  return (
    <>
      {items.length === 0 && !adding && <p className="muted small">No recurring priorities yet.</p>}
      {items.map((item) => (
        <RecurringRow
          key={item.uid}
          item={item}
          pick={pick}
          save={save}
          onRemove={() => remove(item.uid)}
          titleRef={(box) => {
            if (box) titleBoxes.current.set(item.uid, box);
            else titleBoxes.current.delete(item.uid);
          }}
        />
      ))}
      {adding ? (
        <NewRecurring save={save} onDone={() => setAdding(false)} />
      ) : (
        <div>
          <button ref={addButton} className="btn btn-ghost" onClick={() => setAdding(true)}>
            Add recurring priority
          </button>
        </div>
      )}
    </>
  );
}

/**
 * A recurring priority: its title (saved on blur or Enter; a blank or unchanged one is put back),
 * its category chip, its seven days, each pressed to add or drop it, and Remove, which deletes it
 * with no confirm: the rows it added keep their text and category. The last day on stays on, and
 * stays focusable, so the item is always offered on some day.
 */
function RecurringRow({
  item,
  pick,
  save,
  onRemove,
  titleRef,
}: {
  item: Recurring;
  pick: CategoryPick | null;
  save: Save;
  onRemove: () => void;
  titleRef: (box: HTMLInputElement | null) => void;
}) {
  const store = useBoardStore();
  const [draft, setDraft] = useState(item.title);
  const [seen, setSeen] = useState(item.title);
  // A rename that landed, here or on another device, shows in the box.
  if (item.title !== seen) {
    setSeen(item.title);
    setDraft(item.title);
  }
  const edit = (patch: RecurringPatch) => void save(() => store.editRecurring(item.uid, patch));
  const commit = () => {
    const title = draft.trim();
    if (!title || title === item.title) setDraft(item.title);
    else edit({ title });
  };
  const toggleDay = (day: number) => {
    const on = item.weekdays.includes(day);
    if (on && item.weekdays.length === 1) return;
    edit({ weekdays: on ? item.weekdays.filter((d) => d !== day) : [...item.weekdays, day].sort((a, b) => a - b) });
  };
  return (
    <div className="recurring-row">
      <input
        ref={titleRef}
        className="input recurring-title"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.currentTarget.blur();
        }}
        maxLength={LIMITS.priorityText}
        aria-label={`Title of ${item.title}`}
      />
      {pick && <CategoryChip value={item.categoryUid} onChange={(categoryUid) => edit({ categoryUid })} pick={pick} label={`Category for ${item.title}`} />}
      <div className="weekdays" role="group" aria-label={`Days for ${item.title}`}>
        {WEEKDAYS.map(({ day, letter, name }) => {
          const on = item.weekdays.includes(day);
          return (
            <button
              key={day}
              type="button"
              className="chip"
              onClick={() => toggleDay(day)}
              aria-pressed={on}
              aria-disabled={on && item.weekdays.length === 1 ? true : undefined}
              aria-label={name}
            >
              {letter}
            </button>
          );
        })}
      </div>
      <button className="btn btn-ghost" onClick={onRemove} aria-label={`Remove ${item.title}`}>
        Remove
      </button>
    </div>
  );
}

/**
 * The row Add recurring priority opens, its title focused. Enter adds the item, on the work week
 * with no category, and leaves an empty row for the next; the focus leaving adds what is typed and
 * closes the row.
 */
function NewRecurring({ save, onDone }: { save: Save; onDone: () => void }) {
  const store = useBoardStore();
  const [draft, setDraft] = useState('');
  const add = () => {
    const title = draft.trim();
    // On the work week, with no category: both are a tap away in the row it becomes.
    if (title) void save(() => store.addRecurring({ uid: newUid(), title, categoryUid: null, weekdays: [1, 2, 3, 4, 5] }));
  };
  return (
    <div className="recurring-row">
      <input
        className="input recurring-title"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          add();
          onDone();
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.nativeEvent.isComposing || !draft.trim()) return;
          add();
          setDraft('');
        }}
        maxLength={LIMITS.priorityText}
        placeholder="Recurring priority"
        aria-label="New recurring priority"
        autoFocus
      />
    </div>
  );
}
