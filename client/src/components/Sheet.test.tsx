// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOUR_MS } from '../../../shared/dates.js';
import * as api from '../api';
import { LEFT_OPEN, PLAN_NEXT, TODAY_OFFER } from '../lib/copy';
import { SPLIT_QUERY } from '../lib/layout';
import { USER_KEYS } from '../lib/storage';
import {
  AppProviders,
  completedSession,
  deferred,
  makeBoard,
  makeCard,
  makeCategory,
  makeDay,
  makePriority,
  makeRecurring,
  makeSettings,
  serveRange,
  settle,
  T0,
  TODAY,
  YESTERDAY,
} from '../test/hooks';
import type { Board, Settings } from '../types';
import { Sheet } from './Sheet';
import { SortableCards } from './SortableCards';

vi.mock('../api');
vi.mock('../lib/alerts');
// The real drag and drop, wrapped so a test can read what each column was given and play a
// drop: happy-dom lays nothing out, so dnd-kit's sensors have nothing to measure.
vi.mock('./SortableCards', async (importOriginal) => {
  const real = await importOriginal<typeof import('./SortableCards')>();
  return { SortableCards: vi.fn(real.SortableCards) };
});

/** Whether the window is as wide as SPLIT_QUERY asks, as matchMedia answers it now. */
let wideWindow = true;
let stored: Settings;

function SheetAt({ date = TODAY, now = T0, customize = false }: { date?: string; now?: number; customize?: boolean }) {
  return <Sheet date={date} today={TODAY} now={now} customize={customize} jumpTo={null} onJumped={() => {}} onPunchEditing={() => {}} />;
}

async function renderSheet(customize = false) {
  const view = render(
    <AppProviders>
      <SheetAt customize={customize} />
    </AppProviders>,
  );
  await settle();
  // Customize loads drag and drop in a chunk of its own; its grips carry dnd-kit's attributes.
  if (customize) await vi.waitFor(() => expect(document.querySelector('[aria-roledescription="sortable"]')).not.toBeNull());
  return view;
}

/** The card titles in each column, left to right; a sheet in one list is one column. */
function columns(): string[][] {
  const titles = (el: Element) => [...el.querySelectorAll('.card-title')].map((h) => h.textContent);
  const cols = [...document.querySelectorAll('.sheet-col')];
  return cols.length > 0 ? cols.map(titles) : [titles(document.querySelector('.sheet')!)];
}

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const savedLayout = () => vi.mocked(api.putSettings).mock.lastCall?.[0].layout?.map((l) => `${l.id}:${l.side}`);

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  wideWindow = true;
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === SPLIT_QUERY && wideWindow, media: query }) as MediaQueryList);
  stored = makeSettings();
  vi.mocked(api.getSettings).mockImplementation(() => Promise.resolve(stored));
  vi.mocked(api.putSettings).mockImplementation((patch) => {
    stored = { ...stored, ...patch } as Settings;
    return Promise.resolve(stored);
  });
  vi.mocked(api.getRunning).mockResolvedValue({ session: null });
  vi.mocked(api.getDay).mockResolvedValue(makeDay());
  serveRange([]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Sheet', () => {
  it('lays a wide window out in two columns: the timeclock and priorities on the left, the rest on the right', async () => {
    await renderSheet();
    expect(document.querySelector('.sheet--split')).not.toBeNull();
    expect(columns()).toEqual([
      ['Timeclock', 'Top priorities'],
      ['Focus timer', 'Day log', 'Retrospective'],
    ]);
  });

  it('keeps the wide page while a day loads, so ◀ and ▶ leave the width alone', async () => {
    vi.mocked(api.getDay).mockReturnValue(new Promise(() => {}));
    await renderSheet();
    expect(document.querySelector('.sheet--split .sheet-loading')).not.toBeNull();
  });

  it('keeps a narrow window to one list, in the layout order', async () => {
    wideWindow = false;
    await renderSheet();
    expect(document.querySelector('.sheet--split')).toBeNull();
    expect(columns()).toEqual([['Timeclock', 'Top priorities', 'Focus timer', 'Day log', 'Retrospective']]);
  });

  it('keeps the columns it mounted with when the window changes width', async () => {
    const { rerender } = await renderSheet();
    wideWindow = false;
    rerender(
      <AppProviders>
        <SheetAt now={T0 + 1000} />
      </AppProviders>,
    );
    await settle();
    expect(columns()).toHaveLength(2);
  });

  it('moves a card to the other column and keeps its place in the one-column order', async () => {
    await renderSheet(true);
    fireEvent.click(button('Move Focus timer to the left column'));
    await settle();
    expect(savedLayout()).toEqual(['timeclock:left', 'priorities:left', 'timer:left', 'log:right', 'retro:right']);
    expect(columns()).toEqual([
      ['Timeclock', 'Top priorities', 'Focus timer'],
      ['Day log', 'Retrospective'],
    ]);
    // The card mounted again in its new column; its arrow there has the focus.
    expect(document.activeElement).toBe(button('Move Focus timer to the right column'));
  });

  it('steps a card up and down within its own column', async () => {
    await renderSheet(true);
    // Third in the layout, but first in the right column.
    expect(button('Move Focus timer up').disabled).toBe(true);
    expect(button('Move Top priorities down').disabled).toBe(true);
    fireEvent.click(button('Move Day log up'));
    await settle();
    expect(savedLayout()).toEqual(['timeclock:left', 'priorities:left', 'log:right', 'timer:right', 'retro:right']);
    expect(columns()[1]).toEqual(['Day log', 'Focus timer', 'Retrospective']);
  });

  it('keeps a drop inside the column it was dragged in', async () => {
    await renderSheet(true);
    const right = vi
      .mocked(SortableCards)
      .mock.calls.map(([props]) => props)
      .filter((p) => p.cards[0]?.id === 'timer')
      .at(-1)!;
    act(() => right.onReorder(0, right.cards.length - 1));
    await settle();
    expect(savedLayout()).toEqual(['timeclock:left', 'priorities:left', 'log:right', 'retro:right', 'timer:right']);
    expect(columns()[1]).toEqual(['Day log', 'Retrospective', 'Focus timer']);
  });

  it('offers no column moves in a narrow window', async () => {
    wideWindow = false;
    await renderSheet(true);
    expect(screen.queryByRole('button', { name: /column$/ })).toBeNull();
    expect(button('Move Focus timer up').disabled).toBe(false);
  });

  it('shows one list once a column has no visible card, and still offers the move back', async () => {
    stored = makeSettings({ layout: stored.layout.map((l) => ({ ...l, side: 'left' })) });
    await renderSheet(true);
    expect(document.querySelector('.sheet--split')).toBeNull();
    expect(columns()).toEqual([['Timeclock', 'Top priorities', 'Focus timer', 'Day log', 'Retrospective']]);
    fireEvent.click(button('Move Retrospective to the right column'));
    await settle();
    expect(columns()).toEqual([['Timeclock', 'Top priorities', 'Focus timer', 'Day log'], ['Retrospective']]);
  });
});

describe('Sheet: what the last day left open, with the board on', () => {
  it("offers a row whose card is in Next under the card's title in the morning notice, leaves one parked in Later where it is, and waits for the board", async () => {
    stored = makeSettings({ board: true });
    serveRange([
      makeDay(YESTERDAY, {
        priorities: [
          makePriority(1, 'Old title', { cardUid: 'next00000001' }),
          makePriority(2, 'Parked since', { cardUid: 'later0000001' }),
          makePriority(3, 'No card'),
        ],
      }),
    ]);
    const board = deferred<Board>();
    vi.mocked(api.getBoard).mockReturnValue(board.promise);
    await renderSheet();
    expect(screen.queryByText(LEFT_OPEN.title('yesterday'))).toBeNull();
    board.resolve(makeBoard(makeCard('next00000001', 'New title', { lane: 'next' }), makeCard('later0000001', 'Parked since')));
    await settle();
    const offer = screen.getByText(LEFT_OPEN.title('yesterday')).closest('.today-offer')!;
    expect([...offer.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['New title', 'No card']);
    expect(screen.getByRole('button', { name: LEFT_OPEN.dismiss })).toBeTruthy();
  });

  it('offers nothing when every row it would bring back was moved off Next', async () => {
    stored = makeSettings({ board: true });
    serveRange([makeDay(YESTERDAY, { priorities: [makePriority(1, 'Parked', { cardUid: 'later0000001' })] })]);
    vi.mocked(api.getBoard).mockResolvedValue(makeBoard(makeCard('later0000001', 'Parked')));
    await renderSheet();
    expect(screen.queryByText(LEFT_OPEN.title('yesterday'))).toBeNull();
    expect(document.querySelector('.left-open')).toBeNull();
  });
});

describe('Sheet: the recurring priorities due today', () => {
  // TODAY is a Monday.
  const QUEUE = makeRecurring('rcur00000001', 'Monitor the queue');
  const SATURDAY = makeRecurring('rcur00000002', 'Water the plants', { weekdays: [6] });
  const offered = () => [...document.querySelectorAll('.today-offer li')].map((li) => li.textContent);
  const reload = async () => {
    cleanup();
    await renderSheet();
  };

  beforeEach(() => {
    localStorage.clear();
    stored = makeSettings({ board: true });
    vi.mocked(api.getBoard).mockResolvedValue({ ...makeBoard(), recurring: [SATURDAY, QUEUE] });
    vi.mocked(api.putPriorities).mockImplementation((_date, priorities) => Promise.resolve({ priorities }));
  });

  it('offers the ones due on its weekday, and none answered on this device today', async () => {
    await renderSheet();
    expect(offered()).toEqual(['Monitor the queue']);
    expect(screen.getByText(TODAY_OFFER.recurring)).toBeTruthy();
    localStorage.setItem(USER_KEYS.recurringAnswered, `${TODAY} ${QUEUE.uid}`);
    await reload();
    expect(document.querySelector('.today-offer')).toBeNull();
    // Answers from another day count for nothing.
    localStorage.setItem(USER_KEYS.recurringAnswered, `${YESTERDAY} ${QUEUE.uid}`);
    await reload();
    expect(offered()).toEqual(['Monitor the queue']);
  });

  it("adds one after the padded rows, and doesn't offer it again once its row is removed, after a reload too", async () => {
    await renderSheet();
    fireEvent.click(button(LEFT_OPEN.add));
    await settle();
    expect(vi.mocked(api.putPriorities).mock.lastCall![1].map((p) => [p.text, p.recurringUid])).toEqual([
      ['', null],
      ['', null],
      ['', null],
      ['Monitor the queue', QUEUE.uid],
    ]);
    expect(document.querySelector('.today-offer')).toBeNull();
    fireEvent.click(button('Remove priority 4'));
    await settle();
    expect(vi.mocked(api.putPriorities).mock.lastCall![1].some((p) => p.recurringUid != null)).toBe(false);
    expect(document.querySelector('.today-offer')).toBeNull();
    await reload();
    expect(document.querySelector('.today-offer')).toBeNull();
  });

  it('shows the leftovers beside them, and Not today holds both for the day', async () => {
    serveRange([makeDay(YESTERDAY, { priorities: [makePriority(1, 'Invoices')] })]);
    await renderSheet();
    expect(offered()).toEqual(['Invoices', 'Monitor the queue']);
    fireEvent.click(button(TODAY_OFFER.notToday));
    await settle();
    expect(document.querySelector('.today-offer')).toBeNull();
    expect(api.putPriorities).not.toHaveBeenCalled();
    await reload();
    expect(document.querySelector('.today-offer')).toBeNull();
  });

  it('leaves the leftovers for later when Not today answers the routines alone', async () => {
    serveRange([makeDay(YESTERDAY, { priorities: [makePriority(1, 'Invoices')] })]);
    vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { priorities: [makePriority(1, 'Report')] }));
    await renderSheet();
    expect(offered()).toEqual(['Monitor the queue']);
    fireEvent.click(button(TODAY_OFFER.notToday));
    await settle();
    expect(document.querySelector('.today-offer')).toBeNull();
    // With the one-off cleared and saved, the list has no plan, and the leftovers are offered.
    fireEvent.change(screen.getByLabelText('Priority 1'), { target: { value: '' } });
    await settle(1000);
    expect(offered()).toEqual(['Invoices']);
    expect(screen.getByText(LEFT_OPEN.title('yesterday'))).toBeTruthy();
  });

  it("offers nothing on another day's sheet, though today's routines are due", async () => {
    vi.mocked(api.getDay).mockImplementation((d) => Promise.resolve(makeDay(d)));
    render(
      <AppProviders>
        <SheetAt date={YESTERDAY} />
      </AppProviders>,
    );
    await settle();
    expect(api.getBoard).toHaveBeenCalled();
    expect(screen.getByLabelText('Priority 1')).toBeTruthy();
    expect(document.querySelector('.today-offer')).toBeNull();
  });

  it('takes the routines away once the board is switched off on another device, and offers the leftovers in the plain block', async () => {
    serveRange([makeDay(YESTERDAY, { priorities: [makePriority(1, 'Invoices')] })]);
    await renderSheet();
    expect(offered()).toEqual(['Invoices', 'Monitor the queue']);
    stored = makeSettings();
    // The settings are read again each minute; the board keeps its last copy.
    await settle(60_000);
    expect(document.querySelector('.today-offer')).toBeNull();
    expect(screen.getByText(LEFT_OPEN.title('yesterday'))).toBeTruthy();
    expect(screen.queryByText(TODAY_OFFER.recurring)).toBeNull();
  });

  it('offers no routine with the board off, and the plain block still offers the leftovers while the list holds only a routine', async () => {
    stored = makeSettings();
    vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { priorities: [makePriority(1, 'Monitor the queue', { recurringUid: QUEUE.uid })] }));
    serveRange([makeDay(YESTERDAY, { priorities: [makePriority(1, 'Invoices')] })]);
    await renderSheet();
    expect(screen.getByText(LEFT_OPEN.title('yesterday')).closest('.left-open')!.classList.contains('today-offer')).toBe(false);
    expect(screen.queryByText(TODAY_OFFER.recurring)).toBeNull();
    expect(api.getBoard).not.toHaveBeenCalled();
  });
});

describe("Sheet: a category's chip, with the board on", () => {
  const TICKETS = makeCategory('cat000000001', 'Tickets');
  const ADMIN = makeCategory('cat000000002', 'Admin', { color: 'teal' });
  const day = makeDay(TODAY, {
    priorities: [makePriority(1, 'Report', { categoryUid: TICKETS.uid })],
    sessions: [completedSession(1, T0 - HOUR_MS, 25 * 60, { label: 'Inbox', categoryUid: ADMIN.uid })],
  });
  const chips = () => screen.queryAllByRole('button', { name: /^Category for / }).map((b) => b.getAttribute('aria-label'));

  beforeEach(() => {
    vi.mocked(api.getDay).mockResolvedValue(day);
    vi.mocked(api.getBoard).mockResolvedValue({ ...makeBoard(), categories: [TICKETS, ADMIN] });
    vi.mocked(api.putPriorities).mockImplementation((_date, priorities) => Promise.resolve({ priorities }));
  });

  it("gives a priority row, the timer's new row, the log and Plan tomorrow's rows the board's categories", async () => {
    stored = makeSettings({ board: true });
    await renderSheet();
    expect(chips()).toEqual(['Category for priority 1: Tickets']);
    expect(screen.getByRole('img', { name: 'Admin' })).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: 'Session label' }), { target: { value: 'Call the vendor' } });
    fireEvent.click(screen.getByRole('checkbox', { name: "Also add to today's priorities" }));
    fireEvent.click(screen.getByRole('button', { name: 'Category for the new priority: none' }));
    fireEvent.click(screen.getByRole('option', { name: 'Admin' }));
    vi.mocked(api.startSession).mockReturnValue(new Promise(() => {}));
    fireEvent.click(screen.getByRole('button', { name: /^25\s*min$/ }));
    await settle();
    expect(vi.mocked(api.putPriorities).mock.lastCall![1][1]).toMatchObject({ text: 'Call the vendor', categoryUid: ADMIN.uid });

    fireEvent.click(screen.getByRole('button', { name: PLAN_NEXT.open('tomorrow') }));
    await settle();
    const box = screen.getByRole('textbox', { name: PLAN_NEXT.placeholder });
    fireEvent.change(box, { target: { value: 'Book flights' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'Category for Book flights: none' })).toBeTruthy();
  });

  it('shows none of them with the board off', async () => {
    await renderSheet();
    expect(chips()).toEqual([]);
    expect(screen.queryByRole('img', { name: 'Admin' })).toBeNull();
    expect(api.getBoard).not.toHaveBeenCalled();
  });
});
