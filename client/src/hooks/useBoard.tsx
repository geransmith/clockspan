import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import * as api from '../api';
import type { CategoryPatch, ItemPatch, NewCategory, NewItem } from '../api';
import { todayKey } from '../../../shared/dates.js';
import type { Board, Priority, Recurring } from '../types';
import { unlessGone } from '../lib/apiError';
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
import { addPending, fetched, settle, settleWith, shown, untracked, type Tracked } from '../lib/optimistic';
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
  /** The first read failed (Try again is `load`); a later failed read keeps the board shown. */
  failed: boolean;
  /** The settings have loaded with the board switched on. While off, nothing is read and no answer is kept. */
  on: boolean;
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
  /**
   * Reads the board, sharing a read already out; nothing while the board is off. Never rejects.
   * `fresh` is for a caller that has just changed what the server holds (a prune): a read out now
   * may have left before that, so a new one goes after it.
   */
  load(opts?: { fresh?: boolean }): Promise<void>;
  /**
   * A new task in a lane (a column's +, or a done item's new task), refused at the lanes' cap
   * before it is sent, or a new recurring priority made in Settings → Board.
   */
  addItem(item: NewItem): Promise<void>;
  /**
   * A task off today's list edited on the board, or a recurring priority renamed, given a category
   * or other weekdays in Settings → Board, which reaches every day it is on. After a new name,
   * category or note, the held days that name the task and the ranges on screen are read again
   * (`taskChanged`).
   */
  editItem(uid: string, patch: ItemPatch): Promise<void>;
  /**
   * A one-off task deleted everywhere, the board's Delete and the sheet's: off the board at once,
   * then, once today's saves are in (so a task typed seconds ago exists or never went),
   * `DELETE /items/:uid`, which takes it off every day, today's list included, and leaves its
   * tombstone (a 404 counts as done: another device deleted it already), then every held day that
   * named it read again and the ranges on screen with them (`taskChanged`). Works with the board off.
   */
  deleteItem(uid: string): Promise<void>;
  /** A recurring priority removed in Settings → Board: it stops repeating, and the days it was on keep it (a 404 counts as done). */
  removeRecurring(uid: string): Promise<void>;
  /** A row taken off today's list from the board as × takes it (`takeOffRow`): a recurring priority's Remove from today. */
  removeFromToday(uid: string): Promise<void>;
  /**
   * A row of today's list renamed, given a category or a note on the board, which reaches every day
   * its task is on and shows on the board's copy at once (a recurring priority in Settings → Board,
   * its earlier ticks in Done). A row gone from today's list meanwhile has its task patched
   * instead.
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
 * settings. While on, `BoardRefresh` reads it every minute and when the tab comes back. While off
 * nothing is read and a write's answer isn't kept, but the writes the sheet makes through it (a
 * task deleted everywhere) still go out.
 */
export function BoardProvider({ children }: { children: ReactNode }) {
  const { tracked, current, change, nextId, queue } = useTracked<Tracked<Board>>(untracked);
  const [failed, setFailed] = useState(false);
  const { settings, loaded } = useSettings();
  const on = loaded && settings.board;
  const onRef = useLatest(on);
  const priorityCount = useLatest(settings.priorityCount);
  const dayStore = useDayStore();
  const inflight = useRef<Promise<void> | null>(null);

  const read = useCallback((): Promise<void> => {
    if (!onRef.current) return Promise.resolve();
    if (inflight.current) return inflight.current;
    const sentAt = current().version;
    const out = api
      .getBoard()
      .then((b) => {
        change((t) => fetched(t, sentAt, b).next);
        setFailed(false);
      })
      .catch(() => {
        if (current().confirmed === undefined) setFailed(true);
      })
      .finally(() => {
        inflight.current = null;
      });
    inflight.current = out;
    return out;
  }, [onRef, current, change]);

  // A fresh read goes once the one out has answered: it then starts one, or shares one sent since.
  const load = useCallback(
    ({ fresh = false }: { fresh?: boolean } = {}): Promise<void> => {
      const out = inflight.current;
      return fresh && out ? out.then(read) : read();
    },
    [read],
  );

  // A board change shown from now until the server has answered for it.
  const pend = useCallback(
    (apply: (b: Board) => Board) => {
      const id = nextId();
      change((t) => addPending(t, id, apply));
      return id;
    },
    [nextId, change],
  );

  // The server's answer for change `id`: its board laid on while the board is on (null: confirmed
  // as shown, a delete answered 404). A failure takes the change off, reads the board again and
  // rejects.
  const answer = useCallback(
    async (id: number, apply: (b: Board) => Board, run: () => Promise<Board | null>): Promise<void> => {
      try {
        const saved = await run();
        change((t) => (saved && onRef.current ? settleWith(t, [id], saved) : settle(t, [id], apply)));
      } catch (err) {
        change((t) => settle(t, [id]));
        void load();
        throw err;
      }
    },
    [change, onRef, load],
  );

  // One job on the board queue whose change shows at once, even while an earlier job is out.
  const write = useCallback(
    (apply: (b: Board) => Board, run: () => Promise<Board | null>) => {
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
      const refused = 'lane' in item ? full(item.uid) : null;
      if (refused) return Promise.reject(refused);
      const now = Date.now();
      return write(
        (b) => withItem(b, item, now),
        () => api.addItem(item),
      );
    },
    [full, write],
  );

  // The server renamed, filed or noted it on every day: the board's earlier days in Done, today's row.
  const patchItem = useCallback(
    async (uid: string, patch: ItemPatch) => {
      const saved = await api.editItem(uid, patch);
      if (patch.title !== undefined || patch.categoryUid !== undefined || patch.note !== undefined) dayStore.taskChanged(uid);
      return saved;
    },
    [dayStore],
  );

  const editItem = useCallback(
    (uid: string, patch: ItemPatch) =>
      write(
        (b) => withItemPatch(b, uid, patch),
        () => patchItem(uid, patch),
      ),
    [write, patchItem],
  );

  // Today's list changed by `fn`, inside a job: refused while the list isn't loaded, a failed save
  // thrown, and a change that gave nothing to save thrown only with `whenSkipped` (a full list).
  const editToday = useCallback(
    async (today: string, fn: (rows: Priority[]) => Priority[] | null, whenSkipped?: string): Promise<'saved' | 'skipped'> => {
      const edit = await dayStore.editPriorities(today, fn);
      if (edit === 'notLoaded') throw new MoveRefused(ADD_PRIORITY_FAILED.notLoaded);
      if (edit === 'failed') throw new Error(SAVE_FAILED.title);
      if (edit === 'skipped' && whenSkipped) throw new MoveRefused(whenSkipped);
      return edit;
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
  // since the store's `editItem` would queue behind it.
  const editRow = useCallback(
    (uid: string, patch: RowPatch) => {
      const today = todayKey();
      const itemPatch = itemPatchOf(patch);
      return write(
        (b) => withItemPatch(b, uid, itemPatch),
        async () => ((await setRow(today, uid, patch)) === 'skipped' ? patchItem(uid, itemPatch) : null),
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
      void load({ fresh: true });
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
          const saved = await unlessGone(api.deleteItem(uid));
          dayStore.taskChanged(uid);
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
        () => unlessGone(api.deleteItem(uid)),
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
  const state = useMemo(() => ({ board, confirmedRecurring, failed, on }), [board, confirmedRecurring, failed, on]);
  const store = useMemo(
    () => ({ load, addItem, editItem, deleteItem, removeRecurring, removeFromToday, editRow, move, addCategory, editCategory, removeCategory }),
    [load, addItem, editItem, deleteItem, removeRecurring, removeFromToday, editRow, move, addCategory, editCategory, removeCategory],
  );
  return (
    <StateCtx.Provider value={state}>
      <StoreCtx.Provider value={store}>
        {on && <BoardRefresh refresh={load} />}
        {children}
      </StoreCtx.Provider>
    </StateCtx.Provider>
  );
}

/**
 * The board kept in step while it is on (`useRefreshLoop`: at once, every minute and when the tab
 * comes back). Mounted only while on, so switching the board on reads it at once, and StrictMode's
 * second mount lands inside the loop's throttle and sends nothing more.
 */
function BoardRefresh({ refresh }: { refresh: () => Promise<void> }) {
  useRefreshLoop(refresh, true);
  return null;
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

/** A failed category create, said where the view has no other way: the "Change not saved" banner. */
function bannerOnFailure(saved: Promise<void>): void {
  void saved.catch(warnSaveFailed);
}

/**
 * The category chip's data, for a view that offers the chip and passes it down (the board page,
 * the sheet, Settings → Board); null while the board is off or before its first read. `create`
 * gives the uid to set at once (`categoryForName`): a category is a soft link, so the row or card
 * that takes it needs no wait. A new or removed category goes out as an optimistic `addCategory`,
 * and its failure (a stale copy whose name another device took, or a server cap) takes it off,
 * reads the board again and goes to `report`, the banner by default (Settings → Board passes the
 * dialog's save, whose header says Not saved); what picked it then reads as no category.
 * `refresh` reads the board, as the chip's list does when it opens.
 */
export function useCategoryPick(report: (saved: Promise<void>) => void = bannerOnFailure): CategoryPick | null {
  const { board, on } = useBoardState();
  const store = useBoardStore();
  return useMemo(() => {
    if (!on || !board) return null;
    const { categories } = board;
    return {
      categories,
      create: (name: string) => {
        const made = categoryForName(categories, name, newUid());
        if (made?.send) report(store.addCategory(made.send));
        return made?.uid ?? null;
      },
      refresh: () => void store.load(),
    };
  }, [on, board, store, report]);
}
