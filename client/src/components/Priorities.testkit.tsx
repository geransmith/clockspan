import { render, screen } from '@testing-library/react';
import { beforeEach, vi } from 'vitest';
import { mergePriorities } from '../../../shared/priorities.js';
import * as api from '../api';
import { useDay } from '../hooks/useDay';
import { SettingsProvider } from '../hooks/useSettings';
import { useBoardStore } from '../hooks/useBoard';
import type { CategoryPick } from '../lib/board';
import { answered, deferred, makeDay, makePriority, QUEUE, settle, SettingsAndDays, ShortcutKeys, T0, TODAY } from '../test/hooks';
import type { Priority, Recurring, Session } from '../types';
import { Priorities } from './Priorities';
import type { MorningOffer } from './TodayOffer';

// What the Priorities.*.test.tsx files share, the clock before each test included. Each one mocks
// '../api' and '../lib/alerts' itself, since `vi.mock` applies only in the file that calls it.

export async function renderCard(priorities: Priority[] = [], sessions: Session[] = [], pick: CategoryPick | null = null, offer: MorningOffer | null = null) {
  const onChange = vi.fn<(p: Priority[], base: Priority[]) => Promise<boolean>>(() => Promise.resolve(true));
  const onDeleteTask = vi.fn<(uid: string) => Promise<void>>(() => Promise.resolve());
  const onNote = vi.fn<(uid: string, note: string) => Promise<boolean>>(() => Promise.resolve(true));
  const card = (rows: Priority[], o: MorningOffer | null) => (
    <SettingsProvider>
      <ShortcutKeys />
      <Priorities priorities={rows} sessions={sessions} now={T0} onChange={onChange} onDeleteTask={onDeleteTask} onNote={onNote} pick={pick} offer={o} />
    </SettingsProvider>
  );
  const view = render(card(priorities, offer));
  await settle();
  return {
    ...view,
    onChange,
    onDeleteTask,
    onNote,
    saved: () => onChange.mock.lastCall![0],
    /** The card again with these rows, and this offer (the one it had unless given). */
    again: (rows: Priority[], o: MorningOffer | null = offer) => view.rerender(card(rows, o)),
  };
}

/** Today's card on the day store and the board store, wired as the sheet wires it. */
function OnTheStore({ pick = null }: { pick?: CategoryPick | null }) {
  const { day, store } = useDay(TODAY);
  const boardStore = useBoardStore();
  return day ? (
    <Priorities
      priorities={day.priorities}
      sessions={day.sessions}
      now={T0}
      pick={pick}
      onChange={(p, base) => store.setPriorities(TODAY, p, base)}
      onDeleteTask={(uid) => boardStore.deleteItem(uid)}
      onNote={() => Promise.resolve(true)}
    />
  ) : null;
}

/**
 * Renders `OnTheStore` against a server that stores each save as the route does (merged with
 * `mergePriorities`, free rows left out) the moment it arrives, and answers it once `answer()` is
 * called.
 */
export async function renderOnStore(rows: Priority[], pick: CategoryPick | null = null) {
  let onServer = rows;
  const gate = deferred<void>();
  vi.mocked(api.getDay).mockImplementation(() => Promise.resolve(answered(makeDay(TODAY, { priorities: onServer }))));
  vi.mocked(api.putPriorities).mockImplementation(async (_date, list, base) => {
    onServer = mergePriorities(onServer, base ?? onServer, list).filter((p) => p.uid != null);
    const priorities = onServer;
    await gate.promise;
    return answered({ priorities });
  });
  render(
    <SettingsAndDays>
      <OnTheStore pick={pick} />
    </SettingsAndDays>,
  );
  await settle();
  return {
    stored: () => onServer,
    answer: async () => {
      gate.resolve();
      await settle();
    },
  };
}

export const textbox = (n: number) => screen.getByLabelText(`Priority ${n}`) as HTMLTextAreaElement;

/** The seeded routine, filed under a category. */
export const FILED_QUEUE = { ...QUEUE, categoryUid: 'cafe00000001' };
/** A row of today's list that is `item`. */
export const routineRow = (position: number, item: Recurring, patch: Partial<Priority> = {}) =>
  makePriority(position, item.title, { uid: item.uid, recurring: true, categoryUid: item.categoryUid, ...patch });

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
