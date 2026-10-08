import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import * as api from '../api';
import type { CardPatch, CategoryPatch, NewCard, NewCategory, RecurringPatch } from '../api';
import { todayKey } from '../../../shared/dates.js';
import { hasText } from '../../../shared/priorities.js';
import type { Board, Priority, Recurring } from '../types';
import { ApiError } from '../lib/apiError';
import { warnQuietly } from '../lib/alerts';
import {
  categoryForName,
  MoveRefused,
  needsCard,
  withCard,
  withCategory,
  withCategoryPatch,
  withoutCard,
  withoutCategory,
  withoutRecurring,
  withPatch,
  withRecurring,
  withRecurringPatch,
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
  /** The first read failed (Try again is `load`); a later failed read keeps the board shown. */
  failed: boolean;
  /** The settings have loaded with the board switched on. While off, nothing is read or sent. */
  on: boolean;
}

/**
 * The board's writes, each one job on the `'board'` queue, so they reach the server in the order
 * made. A card's change shows at once, and a write rejects when it fails (the board is read
 * again). A move that changes today's list awaits that save inside its job; the day store shows
 * it from the moment the job sends it. The board makes the uids of the cards it creates, as the
 * server makes a row's card when a priorities save asks (`cards`). The object keeps its identity
 * for the provider's life.
 */
export interface BoardStore {
  /**
   * Reads the board, sharing a read already out; nothing while the board is off. Never rejects.
   * `fresh` is for a caller that has just changed what the server holds (a prune) or learned its
   * copy is old (a 409): a read out now may have left before that, so a new one goes after it.
   */
  load(opts?: { fresh?: boolean }): Promise<void>;
  /** A new card (capture, or a done item's new card). */
  addCard(card: NewCard): Promise<void>;
  /**
   * A card edited on the board, sent with today's date. A 409 (another device has put the card on
   * today's list or a later one) reads today and the board again and rejects with
   * `MoveRefused(BOARD.stale)`.
   */
  editCard(uid: string, patch: Omit<CardPatch, 'today'>): Promise<void>;
  /**
   * One job: today's row `rowUid` off today's list, then the rows linked to the card off
   * `laterDate`'s list (loaded first), then the card deleted (a 404 counts as done: a save in the
   * job may have taken it already). Null for a step with nothing to do; a null `uid` with a row is
   * how a recurring row, which has no card, comes off today's list.
   */
  deleteCard(uid: string | null, rowUid: string | null, laterDate: string | null): Promise<void>;
  /** A row of today's list renamed or given a category on the board, sent with its card as touched. */
  editRow(rowUid: string, patch: Partial<Pick<Priority, 'text' | 'categoryUid'>>, cardUid: string | null): Promise<void>;
  /** A move `planMove` gave, as one job; a step that changes today's list sends the item's card as touched. */
  move(move: StoreMove): Promise<void>;
  /** A new category, or a removed one brought back under its uid (`categoryForName` says which). */
  addCategory(category: NewCategory): Promise<void>;
  /** A category renamed or recoloured in Settings → Board. */
  editCategory(uid: string, patch: CategoryPatch): Promise<void>;
  /** A category removed in Settings → Board: archived, so past time keeps its name. */
  removeCategory(uid: string): Promise<void>;
  /** A new recurring priority, made in Settings → Board. */
  addRecurring(item: Recurring): Promise<void>;
  /** A recurring priority renamed, given a category or other weekdays in Settings → Board; the rows it added keep theirs. */
  editRecurring(uid: string, patch: RecurringPatch): Promise<void>;
  /** A recurring priority deleted for good in Settings → Board (a 404 counts as done: another device deleted it). */
  removeRecurring(uid: string): Promise<void>;
}

const StateCtx = createContext<BoardState | null>(null);
const StoreCtx = createContext<BoardStore | null>(null);

/** Why an edit of today's list can't go on: not loaded, a failed save, or `skipped` where that means something (a full list). */
function editRefused(edit: PrioritiesEdit, skipped: string | null): Error | null {
  if (edit === 'notLoaded') return new MoveRefused(ADD_PRIORITY_FAILED.notLoaded);
  if (edit === 'failed') return new Error(SAVE_FAILED.title);
  return edit === 'skipped' && skipped ? new MoveRefused(skipped) : null;
}

/** The list without the rows `drop` picks, renumbered; null when it picks none. */
function without(rows: Priority[], drop: (p: Priority) => boolean): Priority[] | null {
  return rows.some(drop) ? rows.filter((p) => !drop(p)).map((p, i) => ({ ...p, position: i + 1 })) : null;
}

/** A 404 on a delete: another device, or a save in this job, took the card (or the recurring priority) already. */
async function unlessGone(send: Promise<Board>): Promise<Board | null> {
  try {
    return await send;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/**
 * The board: the server's cards plus the writes not confirmed yet (`lib/optimistic.ts`), like
 * the settings. Inert while the board is off. While on, `BoardRefresh` reads it every minute and
 * when the tab comes back, and once a day the first read that finds today held gives today's
 * rows typed before the board was on their cards (the sweep): one priorities save asking for
 * cards, before Plan tomorrow can carry such a row and make a second card for its task.
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
  // The day whose list the sweep has done, or is doing: once per page load and day.
  const swept = useRef<string | null>(null);

  // Rows typed while the board was off have no card. After a read, once a day, today's list goes
  // out asking for cards (the day store's `cards`), unless every row has one already.
  const sweep = useCallback(() => {
    const today = todayKey();
    if (swept.current === today) return;
    if (!dayStore.shown(today)?.priorities.some(needsCard)) {
      // Held with every row carded: done for the day. Not held: the next read looks again.
      if (dayStore.shown(today)) swept.current = today;
      return;
    }
    swept.current = today;
    void queue(async () => {
      // Today stays held once it is (the day store drops no day), so the save sends or fails.
      const edit = await dayStore.editPriorities(today, (rows) => (rows.some(needsCard) ? rows : null));
      // A failed save raised the day store's banner; the next read tries again.
      if (edit === 'failed') swept.current = null;
    }, 'board');
  }, [dayStore, queue]);

  const read = useCallback((): Promise<void> => {
    if (!onRef.current) return Promise.resolve();
    if (inflight.current) return inflight.current;
    const sentAt = current().version;
    const out = api
      .getBoard()
      .then((b) => {
        change((t) => fetched(t, sentAt, b).next);
        setFailed(false);
        sweep();
      })
      .catch(() => {
        if (current().confirmed === undefined) setFailed(true);
      })
      .finally(() => {
        inflight.current = null;
      });
    inflight.current = out;
    return out;
  }, [onRef, current, change, sweep]);

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

  // The server's answer for change `id`: its board laid on (null: confirmed as shown, a delete
  // answered 404). A failure takes the change off, reads the board again and rejects; a 409 reads
  // today and the board first and rejects with the stale line.
  const answer = useCallback(
    async (id: number, apply: (b: Board) => Board, run: () => Promise<Board | null>): Promise<void> => {
      try {
        const saved = await run();
        change((t) => (saved ? settleWith(t, [id], saved) : settle(t, [id], apply)));
      } catch (err) {
        change((t) => settle(t, [id]));
        if (err instanceof ApiError && err.status === 409) {
          await Promise.all([dayStore.refresh(todayKey()), load({ fresh: true })]);
          throw new MoveRefused(BOARD.stale);
        }
        void load();
        throw err;
      }
    },
    [change, dayStore, load],
  );

  // One job on the board queue whose change shows at once, even while an earlier job is out.
  const write = useCallback(
    (apply: (b: Board) => Board, run: () => Promise<Board | null>) => {
      const id = pend(apply);
      return queue(() => answer(id, apply, run), 'board');
    },
    [pend, queue, answer],
  );

  const addCard = useCallback(
    (card: NewCard) => {
      const now = Date.now();
      return write(
        (b) => withCard(b, card, now),
        () => api.addCard(card),
      );
    },
    [write],
  );

  const editCard = useCallback(
    (uid: string, patch: Omit<CardPatch, 'today'>) =>
      write(
        (b) => withPatch(b, uid, patch),
        () => api.patchCard(uid, { today: todayKey(), ...patch }),
      ),
    [write],
  );

  // A row of today's list changed through the day store, with its card as touched. A row gone
  // from the list meanwhile is left alone.
  const setRow = useCallback(
    async (rowUid: string, patch: Partial<Pick<Priority, 'text' | 'done' | 'categoryUid'>>, cardUid: string | null) => {
      const now = Date.now();
      const edit = await dayStore.editPriorities(
        todayKey(),
        (rows) => (rows.some((p) => p.uid === rowUid) ? rows.map((p) => (p.uid === rowUid ? editPriority(p, patch, now) : p)) : null),
        cardUid,
      );
      const refused = editRefused(edit, null);
      if (refused) throw refused;
    },
    [dayStore],
  );

  const editRow = useCallback(
    (rowUid: string, patch: Partial<Pick<Priority, 'text' | 'categoryUid'>>, cardUid: string | null) => queue(() => setRow(rowUid, patch, cardUid), 'board'),
    [queue, setRow],
  );

  // A row of today's list to Later or Next: its card placed there, then the row off the list,
  // touched so the save leaves the card where the board put it. A row with no card yet gets one
  // from a save asking for cards first, so a retry after a failed removal places the same card.
  // The card takes the row's title and category as the list shows them when the job runs, since
  // a rename or a category change may have landed while it waited.
  const park = useCallback(
    async ({ row, lane, before }: Extract<StoreMove, { kind: 'park' }>) => {
      const today = todayKey();
      if (row.cardUid == null) {
        const refused = editRefused(await dayStore.editPriorities(today, (rows) => rows), null);
        if (refused) throw refused;
      }
      const listed = dayStore.shown(today)?.priorities.find((p) => p.uid === row.uid);
      const cardUid = row.cardUid ?? listed?.cardUid ?? null;
      if (cardUid == null) {
        // Gone from the list meanwhile (another device took it off): nothing to park.
        if (!listed) return;
        // Still there and no card made: Later and Next are full.
        throw new MoveRefused(BOARD.full);
      }
      const from = listed && hasText(listed) ? listed : row;
      const card: NewCard = { uid: cardUid, title: from.text.trim(), categoryUid: from.categoryUid, lane, before };
      const now = Date.now();
      const apply = (b: Board) => withCard(b, card, now);
      await answer(pend(apply), apply, () => api.addCard(card));
      const refused = editRefused(await dayStore.editPriorities(today, (rows) => without(rows, (p) => p.uid === row.uid), cardUid), null);
      if (refused) throw refused;
    },
    [dayStore, pend, answer],
  );

  const move = useCallback(
    (m: StoreMove): Promise<void> => {
      if (m.kind === 'patch') return editCard(m.uid, m.patch);
      return queue(async () => {
        switch (m.kind) {
          case 'park':
            return park(m);
          case 'tick':
            return setRow(m.rowUid, { done: m.done }, m.cardUid);
          case 'place': {
            const row = { ...m.row, addedAt: Date.now() };
            const edit = await dayStore.editPriorities(todayKey(), (rows) => placePriority(rows, priorityCount.current, row), m.row.cardUid);
            const refused = editRefused(edit, ADD_PRIORITY_FAILED.full);
            if (refused) throw refused;
          }
        }
      }, 'board');
    },
    [editCard, queue, park, setRow, dayStore, priorityCount],
  );

  // The card leaves the board at once; its rows come off today's and the later day's lists in the
  // same job, before the delete, and a failure on the way brings the card back.
  const deleteCard = useCallback(
    (uid: string | null, rowUid: string | null, laterDate: string | null) =>
      write(
        (b) => (uid ? withoutCard(b, uid) : b),
        async () => {
          if (rowUid) {
            const refused = editRefused(await dayStore.editPriorities(todayKey(), (rows) => without(rows, (p) => p.uid === rowUid)), null);
            if (refused) throw refused;
          }
          if (uid && laterDate) {
            await dayStore.load(laterDate);
            const refused = editRefused(await dayStore.editPriorities(laterDate, (rows) => without(rows, (p) => p.cardUid === uid)), null);
            if (refused) throw refused;
          }
          return uid ? unlessGone(api.deleteCard(uid)) : null;
        },
      ),
    [write, dayStore],
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

  const addRecurring = useCallback(
    (item: Recurring) =>
      write(
        (b) => withRecurring(b, item),
        () => api.addRecurring(item),
      ),
    [write],
  );

  const editRecurring = useCallback(
    (uid: string, patch: RecurringPatch) =>
      write(
        (b) => withRecurringPatch(b, uid, patch),
        () => api.patchRecurring(uid, patch),
      ),
    [write],
  );

  const removeRecurring = useCallback(
    (uid: string) =>
      write(
        (b) => withoutRecurring(b, uid),
        () => unlessGone(api.deleteRecurring(uid)),
      ),
    [write],
  );

  const board = useMemo(() => shown(tracked), [tracked]);
  const state = useMemo(() => ({ board, failed, on }), [board, failed, on]);
  const store = useMemo(
    () => ({ load, addCard, editCard, deleteCard, editRow, move, addCategory, editCategory, removeCategory, addRecurring, editRecurring, removeRecurring }),
    [load, addCard, editCard, deleteCard, editRow, move, addCategory, editCategory, removeCategory, addRecurring, editRecurring, removeRecurring],
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
  void saved.catch(() => warnQuietly({ ...SAVE_FAILED, tag: 'save-failed' }));
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
