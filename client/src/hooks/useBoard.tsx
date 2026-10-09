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
  MoveRefused,
  withCategory,
  withCategoryPatch,
  withItem,
  withItemPatch,
  withoutCategory,
  withoutItem,
  type CategoryPick,
  type StoreMove,
} from '../lib/board';
import { ADD_PRIORITY_FAILED, BOARD, SAVE_FAILED } from '../lib/copy';
import { addPending, fetched, settle, settleWith, shown, untracked, type Tracked } from '../lib/optimistic';
import { editPriority, newUid, placePriority } from '../lib/priorities';
import { useDayStore, type PrioritiesEdit } from './useDay';
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
 * The board's writes, each one job on the `'board'` queue, so they reach the server in the order
 * made. A task's change shows at once, and a write rejects when it fails (the board is read
 * again). A move that changes today's list awaits that save inside its job; the day store shows
 * it from the moment the job sends it. The board makes the uids of the tasks it creates. The
 * object keeps its identity for the provider's life.
 */
export interface BoardStore {
  /**
   * Reads the board, sharing a read already out; nothing while the board is off. Never rejects.
   * `fresh` is for a caller that has just changed what the server holds (a prune): a read out now
   * may have left before that, so a new one goes after it.
   */
  load(opts?: { fresh?: boolean }): Promise<void>;
  /** A new task in a lane (capture, or a done item's new task), or a new recurring priority made in Settings → Board. */
  addItem(item: NewItem): Promise<void>;
  /**
   * A task off today's list edited on the board, or a recurring priority renamed, given a category
   * or other weekdays in Settings → Board, which reaches every day it is on. After a new name or
   * category, the held days that name the task and the ranges on screen are read again
   * (`taskChanged`).
   */
  editItem(uid: string, patch: ItemPatch): Promise<void>;
  /**
   * A one-off task deleted everywhere, the board's Delete and the sheet's: off the board at once,
   * off today's list, then, once today's saves are in (so a task typed seconds ago exists or never
   * went), `DELETE /items/:uid` (a 404 counts as done: a save took it already, or another device),
   * then every held day that named it read again and the ranges on screen with them
   * (`taskChanged`). Works with the board off.
   */
  deleteItem(uid: string): Promise<void>;
  /** A recurring priority removed in Settings → Board: it stops repeating, and the days it was on keep it (a 404 counts as done). */
  removeRecurring(uid: string): Promise<void>;
  /** A row taken off today's list from the board: a recurring priority's Remove from today. */
  removeFromToday(uid: string): Promise<void>;
  /**
   * A row of today's list renamed or given a category on the board, which reaches every day its
   * task is on. A recurring row's shows on the board's recurring priority at once, and the held
   * days and ranges that name it are read again once the save is in (`taskChanged`).
   */
  editRow(uid: string, patch: Partial<Pick<Priority, 'text' | 'categoryUid'>>): Promise<void>;
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

/** Why an edit of today's list can't go on: not loaded, a failed save, or `skipped` where that means something (a full list). */
function editRefused(edit: PrioritiesEdit, skipped: string | null): Error | null {
  if (edit === 'notLoaded') return new MoveRefused(ADD_PRIORITY_FAILED.notLoaded);
  if (edit === 'failed') return new Error(SAVE_FAILED.title);
  return edit === 'skipped' && skipped ? new MoveRefused(skipped) : null;
}

/** The list without the task's row, renumbered; null when the list doesn't hold it. */
function without(rows: Priority[], uid: string): Priority[] | null {
  return rows.some((p) => p.uid === uid) ? rows.filter((p) => p.uid !== uid).map((p, i) => ({ ...p, position: i + 1 })) : null;
}

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
      return queue(() => answer(id, apply, run), 'board');
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
      const now = Date.now();
      return write(
        (b) => withItem(b, item, now),
        () => api.addItem(item),
      );
    },
    [write],
  );

  const editItem = useCallback(
    (uid: string, patch: ItemPatch) =>
      write(
        (b) => withItemPatch(b, uid, patch),
        async () => {
          const saved = await api.editItem(uid, patch);
          // The server renamed or filed it on every day: the board's earlier days in Done, today's row.
          if (patch.title !== undefined || patch.categoryUid !== undefined) dayStore.taskChanged(uid);
          return saved;
        },
      ),
    [write, dayStore],
  );

  // A row of today's list changed through the day store. A row gone from the list meanwhile is left alone.
  const setRow = useCallback(
    async (uid: string, patch: Partial<Pick<Priority, 'text' | 'done' | 'categoryUid'>>) => {
      const now = Date.now();
      const edit = await dayStore.editPriorities(todayKey(), (rows) =>
        rows.some((p) => p.uid === uid) ? rows.map((p) => (p.uid === uid ? editPriority(p, patch, now) : p)) : null,
      );
      const refused = editRefused(edit, null);
      if (refused) throw refused;
    },
    [dayStore],
  );

  // A recurring row's save renames or files its recurring priority on every day: the board's copy
  // shows it at once (Settings → Board, its earlier ticks in Done), and once the save is in, the
  // days that hold it are read again.
  const editRow = useCallback(
    (uid: string, patch: Partial<Pick<Priority, 'text' | 'categoryUid'>>) => {
      if (!shown(current())?.recurring.some((r) => r.uid === uid)) return queue(() => setRow(uid, patch), 'board');
      return write(
        (b) => withItemPatch(b, uid, { title: patch.text, categoryUid: patch.categoryUid }),
        async () => {
          await setRow(uid, patch);
          dayStore.taskChanged(uid);
          return null;
        },
      );
    },
    [current, queue, setRow, write, dayStore],
  );

  // Today's list without the task, once that day's save is in. A row gone already sends nothing.
  const offToday = useCallback(
    async (uid: string) => {
      const refused = editRefused(await dayStore.editPriorities(todayKey(), (rows) => without(rows, uid)), null);
      if (refused) throw refused;
    },
    [dayStore],
  );

  const removeFromToday = useCallback((uid: string) => queue(() => offToday(uid), 'board'), [queue, offToday]);

  // A row of today's list to Later or Next: once today's save still out has landed, so a task
  // typed seconds ago exists on the server, the task is placed, then its row leaves the list. The
  // place comes first, so the save's clean-up never takes a task with no lane, and a retry after a
  // failed removal places the same task. Refused at the cap, nothing is removed.
  const park = useCallback(
    async ({ uid, lane, before }: Extract<StoreMove, { kind: 'park' }>) => {
      await dayStore.prioritiesSaved(todayKey());
      const refused = full(uid);
      if (refused) throw refused;
      const patch = { lane, before };
      const apply = (b: Board) => withItemPatch(b, uid, patch);
      await answer(pend(apply), apply, () => api.editItem(uid, patch));
      await offToday(uid);
    },
    [dayStore, full, pend, answer, offToday],
  );

  const move = useCallback(
    (m: StoreMove): Promise<void> => {
      if (m.kind === 'patch') {
        const refused = m.patch.lane ? full(m.uid) : null;
        return refused ? Promise.reject(refused) : editItem(m.uid, m.patch);
      }
      return queue(async () => {
        switch (m.kind) {
          case 'park':
            return park(m);
          case 'tick':
            return setRow(m.uid, { done: m.done });
          case 'place': {
            const row = { ...m.row, addedAt: Date.now() };
            const edit = await dayStore.editPriorities(todayKey(), (rows) => placePriority(rows, priorityCount.current, row));
            const refused = editRefused(edit, ADD_PRIORITY_FAILED.full);
            if (refused) throw refused;
          }
        }
      }, 'board');
    },
    [full, editItem, queue, park, setRow, dayStore, priorityCount],
  );

  // Today's saves go first: today's row comes off, or the sheet's save that took it off lands, so
  // a task typed seconds ago is stored and then taken off, or never sent. Other days' saves still
  // out aren't waited for: the server drops a row naming a deleted task, so none of them can bring
  // it back.
  const deleteItem = useCallback(
    (uid: string) =>
      write(
        (b) => withoutItem(b, uid),
        async () => {
          const today = todayKey();
          if (dayStore.shown(today)?.priorities.some((p) => p.uid === uid)) await offToday(uid);
          else await dayStore.prioritiesSaved(today);
          const saved = await unlessGone(api.deleteItem(uid));
          dayStore.taskChanged(uid);
          return saved;
        },
      ),
    [write, dayStore, offToday],
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
