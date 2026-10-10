import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import * as api from '../api';
import type { CategoryPatch, ItemPatch, NewCategory, NewItem } from '../api';
import { todayKey } from '../../../shared/dates.js';
import type { Board, BoardCard, Priority, Recurring } from '../types';
import { goneAt } from '../lib/apiError';
import { warnSaveFailed } from '../lib/alerts';
import {
  addsToLanes,
  boardFull,
  categoryForName,
  itemPatchOf,
  MoveRefused,
  withCategory,
  withCategoryPatch,
  withItem,
  withItemPatch,
  withoutCategory,
  withoutItem,
  type CategoryPick,
  type RowPatch,
  type StoreMove,
} from '../lib/board';
import { ADD_PRIORITY_FAILED, BOARD, SAVE_FAILED } from '../lib/copy';
import { addPending, confirm, fetched, settle, settleWith, shown, untracked, type Tracked } from '../lib/optimistic';
import { newUid, patchRow, placePriority, takeOffRow } from '../lib/priorities';
import { useDayStore } from './useDay';
import { useLatest } from './useLatest';
import { useRefreshLoop } from './useRefreshLoop';
import { useSettings } from './useSettings';
import { useTracked } from './useTracked';

export interface BoardState {
  /** The server's board with the writes on their way laid over it; undefined until the first read. */
  board: Board | undefined;
  /**
   * The recurring priorities the morning offer may add: those shown that the server has
   * confirmed, so never one whose create is still on its way, which a list save would make a
   * one-off. Undefined until the first read.
   */
  confirmedRecurring: Recurring[] | undefined;
  /**
   * The cards shown that the server has confirmed, which the morning offer's Up next takes from:
   * never one whose create is still on its way, which a list save would make with no lane.
   * Undefined until the first read.
   */
  confirmedCards: BoardCard[] | undefined;
  /** The first read failed (Try again is `load`); a later failed read keeps the board shown. */
  failed: boolean;
}

/**
 * The board's writes, each one job on the board store's queue, so they reach the server in the
 * order made. A task's change shows at once, and a write rejects when it fails (the board is read
 * again). A move that changes today's list awaits that save inside its job; the day store shows
 * it from the moment the job sends it. Today is the day the write was made on, even when its job
 * runs after midnight. The board makes the uids of the tasks it creates. The object keeps its
 * identity for the provider's life.
 */
export interface BoardStore {
  /** Reads the board. Never rejects. */
  load(): Promise<void>;
  /** A new task in a lane (a column's +, or a done item's new task), refused at the lanes' cap before it is sent. */
  addItem(item: NewItem): Promise<void>;
  /**
   * A task off today's list edited on the board, or a weekday set or cleared on any task's card,
   * which reaches every day it is on. A one-off's first day makes it a recurring priority: that
   * waits for today's saves still out, so a task typed seconds ago exists. After a new name,
   * category or note, or that first day, the held days that name the task and the ranges on screen
   * are read again (`taskChanged`). `task` is the task as the view shows it, which a first day
   * shows as a recurring priority at once when the board hasn't read the task yet.
   */
  editItem(uid: string, patch: ItemPatch, task?: Pick<Recurring, 'title' | 'categoryUid' | 'note'>): Promise<void>;
  /**
   * A one-off task deleted everywhere, the board's Delete and the sheet's: off the board at once,
   * then, once today's saves are in (so a task typed seconds ago exists or never went),
   * `DELETE /items/:uid`, which takes it off every day, today's list included, and leaves its
   * tombstone (a 404 counts as done: another device deleted it already), then every held day that
   * named it read again and the ranges on screen with them (`taskChanged`).
   */
  deleteItem(uid: string): Promise<void>;
  /** A card's Stop Repeating: the recurring priority is archived, and the days it was on keep it (a 404 counts as done). */
  removeRecurring(uid: string): Promise<void>;
  /** A row taken off today's list from the board as × takes it (`takeOffRow`): a recurring priority's Remove From Today. */
  removeFromToday(uid: string): Promise<void>;
  /**
   * A row of today's list renamed, given a category or a note on the board, which reaches every day
   * its task is on and shows on the board's copy at once (a recurring priority's card, its earlier
   * ticks in Done). A row gone from today's list meanwhile has its task patched instead.
   */
  editRow(uid: string, patch: RowPatch): Promise<void>;
  /** A move `planMove` gave, as one job. */
  move(move: StoreMove): Promise<void>;
  /** A new category, or a removed one brought back under its uid (`categoryForName` says which). */
  addCategory(category: NewCategory): Promise<void>;
  /** A category renamed or recoloured in Settings → Board. */
  editCategory(uid: string, patch: CategoryPatch): Promise<void>;
  /** A category removed in Settings → Board: archived, so past time keeps its name. */
  removeCategory(uid: string): Promise<void>;
}

const StateCtx = createContext<BoardState | null>(null);
const StoreCtx = createContext<BoardStore | null>(null);

/**
 * The board: the server's tasks plus the writes not confirmed yet (`lib/optimistic.ts`), like the
 * settings, read at once, every minute and when the tab comes back (`useRefreshLoop`; StrictMode's
 * second mount lands inside its throttle).
 */
export function BoardProvider({ children }: { children: ReactNode }) {
  const { tracked, current, change, nextId, queue } = useTracked<Tracked<Board>>(untracked);
  const [failed, setFailed] = useState(false);
  const { settings } = useSettings();
  const priorityCount = useLatest(settings.priorityCount);
  const dayStore = useDayStore();

  // Never shared: a read sent after a change (a refused write, a prune, a park) answers for it,
  // and one still out from before answers lower and is dropped.
  const load = useCallback((): Promise<void> => {
    return api
      .getBoard()
      .then(({ value, revision }) => {
        change((t) => fetched(t, value, revision).next);
        setFailed(false);
      })
      .catch(() => {
        if (current().confirmed === undefined) setFailed(true);
      });
  }, [current, change]);
  useRefreshLoop(load, true);

  // A board change shown from now until the server has answered for it.
  const pend = useCallback(
    (apply: (b: Board) => Board) => {
      const id = nextId();
      change((t) => addPending(t, id, apply));
      return id;
    },
    [nextId, change],
  );

  // The server's answer for change `id`: its board laid on (null: confirmed as shown, a delete
  // answered 404 or a row saved through the day store). A failure takes the change off, reads the
  // board again and rejects.
  const answer = useCallback(
    async (id: number, apply: (b: Board) => Board, run: () => Promise<api.Answer<Board | null>>): Promise<void> => {
      try {
        const { value: saved, revision } = await run();
        change((t) => (saved ? settleWith(t, [id], saved, revision) : confirm(settle(t, [id]), apply, revision)));
      } catch (err) {
        change((t) => settle(t, [id]));
        void load();
        throw err;
      }
    },
    [change, load],
  );

  // One job on the board queue whose change shows at once, even while an earlier job is out.
  const write = useCallback(
    (apply: (b: Board) => Board, run: () => Promise<api.Answer<Board | null>>) => {
      const id = pend(apply);
      return queue(() => answer(id, apply, run));
    },
    [pend, queue, answer],
  );

  // A lane given to a task that takes room there is refused at the cap before anything is sent,
  // with the board's line, as the server would refuse it; its own refusal stays the backstop.
  const full = useCallback(
    (uid: string): MoveRefused | null => {
      const board = shown(current());
      return board && boardFull(board) && addsToLanes(board, uid) ? new MoveRefused(BOARD.full) : null;
    },
    [current],
  );

  const addItem = useCallback(
    (item: NewItem) => {
      const refused = full(item.uid);
      if (refused) return Promise.reject(refused);
      const now = Date.now();
      return write(
        (b) => withItem(b, item, now),
        () => api.addItem(item),
      );
    },
    [full, write],
  );

  // The server renamed, filed or noted it on every day, or made it a recurring priority there
  // (`converts`): the board's earlier days in Done, today's row.
  const patchItem = useCallback(
    async (uid: string, patch: ItemPatch, converts = false) => {
      const saved = await api.editItem(uid, patch);
      if (converts || patch.title !== undefined || patch.categoryUid !== undefined || patch.note !== undefined) dayStore.taskChanged(uid, saved.revision);
      return saved;
    },
    [dayStore],
  );

  const editItem = useCallback(
    (uid: string, patch: ItemPatch, task?: Pick<Recurring, 'title' | 'categoryUid' | 'note'>) => {
      const today = todayKey();
      // A day set on a task the board doesn't hold as a recurring priority makes it one.
      const converts = patch.weekday?.on === true && !shown(current())?.recurring.some((r) => r.uid === uid);
      return write(
        (b) => withItemPatch(b, uid, patch, task),
        async () => {
          if (converts) await dayStore.prioritiesSaved(today);
          return patchItem(uid, patch, converts);
        },
      );
    },
    [current, write, dayStore, patchItem],
  );

  // Today's list changed by `fn`, inside a job, answered at its save's revision: refused while the
  // list isn't loaded, a failed save thrown, and a change that gave nothing to save thrown only with
  // `whenSkipped` (a full list).
  const editToday = useCallback(
    async (today: string, fn: (rows: Priority[]) => Priority[] | null, whenSkipped?: string): Promise<api.Answer<'saved' | 'skipped'>> => {
      const { value: edit, revision } = await dayStore.editPriorities(today, fn);
      if (edit === 'notLoaded') throw new MoveRefused(ADD_PRIORITY_FAILED.notLoaded);
      if (edit === 'failed') throw new Error(SAVE_FAILED.title);
      if (edit === 'skipped' && whenSkipped) throw new MoveRefused(whenSkipped);
      return { value: edit, revision };
    },
    [dayStore],
  );

  // A row of today's list changed through the day store: 'skipped' when the row has gone meanwhile.
  const setRow = useCallback(
    (today: string, uid: string, patch: Partial<Pick<Priority, 'text' | 'done' | 'categoryUid' | 'note'>>) =>
      editToday(today, (rows) => patchRow(rows, uid, patch)),
    [editToday],
  );

  // A rename, category or note reaches every day the task is on, so a row gone from today's list
  // meanwhile (another device took it off) still has it: sent to the task itself, in this job,
  // since the store's `editItem` would queue behind it. Saved through today's list, it is confirmed
  // at that PUT's revision, so a board read out from before, which answers below it, is dropped.
  const editRow = useCallback(
    (uid: string, patch: RowPatch) => {
      const today = todayKey();
      const itemPatch = itemPatchOf(patch);
      return write(
        (b) => withItemPatch(b, uid, itemPatch),
        async () => {
          const { value: edit, revision } = await setRow(today, uid, patch);
          return edit === 'skipped' ? patchItem(uid, itemPatch) : { value: null, revision };
        },
      );
    },
    [write, setRow, patchItem],
  );

  // Today's list without the task, as × leaves it, once that day's save is in. A row gone already sends nothing.
  const offToday = useCallback(
    (today: string, uid: string) =>
      editToday(today, (rows) => {
        const row = rows.find((p) => p.uid === uid);
        return row ? takeOffRow(rows, row.position, priorityCount.current) : null;
      }),
    [editToday, priorityCount],
  );

  const removeFromToday = useCallback(
    (uid: string) => {
      const today = todayKey();
      return queue(async () => {
        await offToday(today, uid);
      });
    },
    [queue, offToday],
  );

  // A row of today's list to Later or Next: once today's save still out has landed, so a task
  // typed seconds ago exists on the server, the task is placed, then its row leaves the list. The
  // place comes first, so the save's clean-up never takes a task with no lane, and a retry after a
  // failed removal places the same task. Refused at the cap, nothing is removed. The board is read
  // again after: a task pulled back from Done is done again once its row is off today.
  const park = useCallback(
    async (today: string, { uid, lane, before }: Extract<StoreMove, { kind: 'park' }>) => {
      await dayStore.prioritiesSaved(today);
      const refused = full(uid);
      if (refused) throw refused;
      const patch = { lane, before };
      const apply = (b: Board) => withItemPatch(b, uid, patch);
      await answer(pend(apply), apply, () => api.editItem(uid, patch));
      await offToday(today, uid);
      void load();
    },
    [dayStore, full, pend, answer, offToday, load],
  );

  const move = useCallback(
    (m: StoreMove): Promise<void> => {
      if (m.kind === 'patch') {
        const refused = m.patch.lane ? full(m.uid) : null;
        return refused ? Promise.reject(refused) : editItem(m.uid, m.patch);
      }
      const today = todayKey();
      return queue(async () => {
        switch (m.kind) {
          case 'park':
            return park(today, m);
          case 'tick':
            // A row gone meanwhile is left alone.
            await setRow(today, m.uid, { done: m.done });
            return;
          case 'place': {
            const row = { ...m.row, addedAt: Date.now() };
            await editToday(today, (rows) => placePriority(rows, priorityCount.current, row), ADD_PRIORITY_FAILED.full);
          }
        }
      });
    },
    [full, editItem, queue, park, setRow, editToday, priorityCount],
  );

  // Today's saves go first, so a task typed seconds ago is stored, or the sheet's save that took
  // it off has landed. The server's delete then takes every day's entry, today's included, and
  // leaves the tombstone a device still holding the row can't bring the task back past. Other
  // days' saves still out aren't waited for: the server drops a row naming a deleted task.
  const deleteItem = useCallback(
    (uid: string) => {
      const today = todayKey();
      return write(
        (b) => withoutItem(b, uid),
        async () => {
          await dayStore.prioritiesSaved(today);
          const saved = await goneAt(api.deleteItem(uid));
          dayStore.taskChanged(uid, saved.revision);
          return saved;
        },
      );
    },
    [write, dayStore],
  );

  const removeRecurring = useCallback(
    (uid: string) =>
      write(
        (b) => withoutItem(b, uid),
        () => goneAt(api.deleteItem(uid)),
      ),
    [write],
  );

  const addCategory = useCallback(
    (category: NewCategory) =>
      write(
        (b) => withCategory(b, category),
        () => api.addCategory(category),
      ),
    [write],
  );

  const editCategory = useCallback(
    (uid: string, patch: CategoryPatch) =>
      write(
        (b) => withCategoryPatch(b, uid, patch),
        () => api.patchCategory(uid, patch),
      ),
    [write],
  );

  const removeCategory = useCallback(
    (uid: string) =>
      write(
        (b) => withoutCategory(b, uid),
        () => api.deleteCategory(uid),
      ),
    [write],
  );

  const board = useMemo(() => shown(tracked), [tracked]);
  const confirmedRecurring = useMemo(() => {
    const confirmed = new Set(tracked.confirmed?.recurring.map((r) => r.uid));
    return board?.recurring.filter((r) => confirmed.has(r.uid));
  }, [board, tracked.confirmed]);
  const confirmedCards = useMemo(() => {
    const confirmed = new Set(tracked.confirmed?.cards.map((c) => c.uid));
    return board?.cards.filter((c) => confirmed.has(c.uid));
  }, [board, tracked.confirmed]);
  const state = useMemo(() => ({ board, confirmedRecurring, confirmedCards, failed }), [board, confirmedRecurring, confirmedCards, failed]);
  const store = useMemo(
    () => ({ load, addItem, editItem, deleteItem, removeRecurring, removeFromToday, editRow, move, addCategory, editCategory, removeCategory }),
    [load, addItem, editItem, deleteItem, removeRecurring, removeFromToday, editRow, move, addCategory, editCategory, removeCategory],
  );
  return (
    <StateCtx.Provider value={state}>
      <StoreCtx.Provider value={store}>{children}</StoreCtx.Provider>
    </StateCtx.Provider>
  );
}

export function useBoardState(): BoardState {
  const v = useContext(StateCtx);
  if (!v) throw new Error('useBoardState outside BoardProvider');
  return v;
}

export function useBoardStore(): BoardStore {
  const v = useContext(StoreCtx);
  if (!v) throw new Error('useBoardStore outside BoardProvider');
  return v;
}

/**
 * The category chip's data, for a view that offers the chip and passes it down (the board page and
 * the sheet); null before the board's first read. `create` gives the uid to set at once
 * (`categoryForName`): a category is a soft link, so the row or card that takes it needs no wait.
 * A new or removed category goes out as an optimistic `addCategory`, and its failure (a stale copy
 * whose name another device took, or a server cap) takes it off, reads the board again and raises
 * the "Change not saved" banner; what picked it then reads as no category. `refresh` reads the
 * board, as the chip's list does when it opens.
 */
export function useCategoryPick(): CategoryPick | null {
  const { board } = useBoardState();
  const store = useBoardStore();
  return useMemo(() => {
    if (!board) return null;
    const { categories } = board;
    return {
      categories,
      create: (name: string) => {
        const made = categoryForName(categories, name, newUid());
        if (made?.send) void store.addCategory(made.send).catch(warnSaveFailed);
        return made?.uid ?? null;
      },
      refresh: () => void store.load(),
    };
  }, [board, store]);
}
