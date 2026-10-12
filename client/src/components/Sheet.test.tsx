// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../../../shared/dates.js';
import * as api from '../api';
import { useDayStore } from '../hooks/useDay';
import { warnQuietly, warnSaveFailed } from '../lib/alerts';
import { ApiError } from '../lib/apiError';
import { LEFT_OPEN, LOAD_FAILED, PUNCH_ORDER, REMOVE_TASK, TODAY_OFFER } from '../lib/copy';
import { SPLIT_QUERY } from '../lib/layout';
import { applySettingsPatch } from '../lib/settings';
import {
  ADMIN,
  answered,
  AppProviders,
  completedSession,
  deferredAnswer,
  echoPriorities,
  makeBoard,
  makeCard,
  makeDay,
  makePriority,
  makeRecurring,
  makeSettings,
  punchesAt,
  QUEUE,
  serveRange,
  setVisibility,
  settle,
  stubMatchMedia,
  T0,
  TICKETS,
  TODAY,
  YESTERDAY,
} from '../test/hooks';
import type { Board, CardId, Day, PrioritiesResponse, Settings } from '../types';
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

/** The queries matchMedia matches now: SPLIT_QUERY while the window is wide. */
let media: Set<string>;
let stored: Settings;

function SheetAt({
  date = TODAY,
  now = T0,
  customize = false,
  jumpTo = null,
  onJumped = () => {},
}: {
  date?: string;
  now?: number;
  customize?: boolean;
  jumpTo?: CardId | null;
  onJumped?: () => void;
}) {
  return (
    <Sheet
      date={date}
      today={TODAY}
      now={now}
      customize={customize}
      onToggleCustomize={() => {}}
      onNavigate={() => {}}
      jumpTo={jumpTo}
      onJumped={onJumped}
      onPunchEditing={() => {}}
    />
  );
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

/**
 * The server's stamp on today's morning offer: `putOffer` keeps the first, and `getDay` answers
 * `day` with it, above the ranges' revision, so a reload reads what was sent.
 */
function serveOffer(day: Day = makeDay()) {
  let stamp: number | null = null;
  vi.mocked(api.putOffer).mockImplementation(() => Promise.resolve(answered({ offerAnsweredAt: (stamp ??= Date.now()) })));
  vi.mocked(api.getDay).mockImplementation(() => Promise.resolve(answered({ ...day, offerAnsweredAt: stamp }, 1)));
}

/** Whether the sheet read the days before today for what the last plan left open. */
const lookedBack = () => vi.mocked(api.getRange).mock.calls.some(([, to]) => to === YESTERDAY);

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  media = new Set([SPLIT_QUERY]);
  stubMatchMedia(media);
  stored = makeSettings();
  vi.mocked(api.getSettings).mockImplementation(() => Promise.resolve(answered(stored)));
  vi.mocked(api.putSettings).mockImplementation((patch) => {
    stored = applySettingsPatch(stored, patch);
    return Promise.resolve(answered(stored));
  });
  vi.mocked(api.getDay).mockResolvedValue(answered(makeDay()));
  // The week line reads a range that holds today, and a range lands on each held day it is as new
  // as: a case whose today has rows answers that day at revision 1, above the ranges (0), which
  // serve no today.
  serveRange([]);
});

describe('Sheet', () => {
  it('lays a wide window out in two columns: the timeclock and priorities on the left, the rest on the right', async () => {
    await renderSheet();
    expect(document.querySelector('.sheet--split')).not.toBeNull();
    expect(columns()).toEqual([
      ['Timeclock', 'Top Priorities'],
      ['Focus Timer', 'Day Log', 'Retrospective'],
    ]);
  });

  it('keeps a narrow window to one list, in the layout order', async () => {
    media.delete(SPLIT_QUERY);
    await renderSheet();
    expect(document.querySelector('.sheet--split')).toBeNull();
    expect(columns()).toEqual([['Timeclock', 'Top Priorities', 'Focus Timer', 'Day Log', 'Retrospective']]);
  });

  it('keeps the columns it mounted with when the window changes width', async () => {
    const { rerender } = await renderSheet();
    media.delete(SPLIT_QUERY);
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
    fireEvent.click(button('Move Focus Timer to the left column'));
    await settle();
    expect(savedLayout()).toEqual(['timeclock:left', 'priorities:left', 'timer:left', 'log:right', 'retro:right']);
    expect(columns()).toEqual([
      ['Timeclock', 'Top Priorities', 'Focus Timer'],
      ['Day Log', 'Retrospective'],
    ]);
    // The card mounted again in its new column; its arrow there has the focus.
    expect(document.activeElement).toBe(button('Move Focus Timer to the right column'));
  });

  it('gives the focus to the Show chip of a card hidden, and to the Hide button of a card shown', async () => {
    await renderSheet(true);
    fireEvent.click(button('Hide Day Log'));
    await settle();
    const show = screen.getByRole('button', { name: 'Day Log Show' });
    expect(document.activeElement).toBe(show);
    fireEvent.click(show);
    await settle();
    expect(document.activeElement).toBe(button('Hide Day Log'));
  });

  it("scrolls to the card a banner's button jumps to, opens it and puts the focus in its note box", async () => {
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView');
    const onJumped = vi.fn();
    // Today, not clocked in: the retrospective is folded until the jump opens it.
    const { rerender } = render(
      <AppProviders>
        <SheetAt onJumped={onJumped} />
      </AppProviders>,
    );
    await settle();
    expect(document.querySelector('#card-retro .retro-folded')).not.toBeNull();
    expect(document.querySelector('#card-retro textarea')).toBeNull();
    rerender(
      <AppProviders>
        <SheetAt jumpTo="retro" onJumped={onJumped} />
      </AppProviders>,
    );
    expect(scrolled.mock.contexts).toEqual([document.getElementById('card-retro')]);
    expect(document.activeElement).toBe(document.querySelector('#card-retro textarea'));
    expect(onJumped).toHaveBeenCalled();
    rerender(
      <AppProviders>
        <SheetAt onJumped={onJumped} />
      </AppProviders>,
    );
    expect(document.querySelector('#card-retro textarea')).not.toBeNull();
  });

  // Keyed by date, the row would mount again for a day still loading: Previous day would drop the
  // focus it was pressed with, and the next press would miss.
  it('keeps its date row through a step to a day still loading, and beside a day that failed to load', async () => {
    const yesterday = deferredAnswer<Day>();
    vi.mocked(api.getDay).mockImplementation((d) => (d === YESTERDAY ? yesterday.promise : Promise.resolve(answered(makeDay(d)))));
    const { rerender } = render(
      <AppProviders>
        <SheetAt />
      </AppProviders>,
    );
    await settle();
    const previous = button('Previous day');
    act(() => previous.focus());
    rerender(
      <AppProviders>
        <SheetAt date={YESTERDAY} />
      </AppProviders>,
    );
    expect(document.querySelector('.loading')).not.toBeNull();
    expect(button('Previous day')).toBe(previous);
    expect(document.activeElement).toBe(previous);
    yesterday.reject(new ApiError(500, 'Server error', 0));
    await settle();
    expect(screen.getByRole('alert').textContent).toContain(LOAD_FAILED.title);
    // The notice is the one copy: no banner says it again.
    expect(warnQuietly).not.toHaveBeenCalled();
    expect(button('Previous day')).toBe(previous);
    expect(document.activeElement).toBe(previous);
  });

  it('gives the focus to Previous day as Try Again loads the day in place of its notice', async () => {
    vi.mocked(api.getDay).mockRejectedValueOnce(new ApiError(500, 'Server error', 0));
    await renderSheet();
    const retry = button(LOAD_FAILED.retry);
    act(() => retry.focus());
    fireEvent.click(retry);
    await settle();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.activeElement).toBe(button('Previous day'));
  });

  it('steps a card up and down within its own column', async () => {
    await renderSheet(true);
    // Third in the layout, but first in the right column.
    expect(button('Move Focus Timer up').disabled).toBe(true);
    expect(button('Move Top Priorities down').disabled).toBe(true);
    act(() => button('Move Day Log up').focus());
    fireEvent.click(button('Move Day Log up'));
    await settle();
    expect(savedLayout()).toEqual(['timeclock:left', 'priorities:left', 'log:right', 'timer:right', 'retro:right']);
    expect(columns()[1]).toEqual(['Day Log', 'Focus Timer', 'Retrospective']);
    // At the top of its column the up arrow is off, so the down arrow has the focus.
    expect(document.activeElement).toBe(button('Move Day Log down'));
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
    expect(columns()[1]).toEqual(['Day Log', 'Retrospective', 'Focus Timer']);
  });

  it('offers no column moves in a narrow window', async () => {
    media.delete(SPLIT_QUERY);
    await renderSheet(true);
    expect(screen.queryByRole('button', { name: /column$/ })).toBeNull();
    expect(button('Move Focus Timer up').disabled).toBe(false);
  });

  it('shows one list once a column has no visible card, and still offers the move back', async () => {
    stored = makeSettings({ layout: stored.layout.map((l) => ({ ...l, side: 'left' })) });
    await renderSheet(true);
    expect(document.querySelector('.sheet--split')).toBeNull();
    expect(columns()).toEqual([['Timeclock', 'Top Priorities', 'Focus Timer', 'Day Log', 'Retrospective']]);
    fireEvent.click(button('Move Retrospective to the right column'));
    await settle();
    expect(columns()).toEqual([['Timeclock', 'Top Priorities', 'Focus Timer', 'Day Log'], ['Retrospective']]);
  });
});

describe("Sheet: the day's focus total", () => {
  it('shows it in the Day Log only while the timeclock card, whose Focused tile has it, is hidden', async () => {
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { sessions: [completedSession(1, T0 - HOUR_MS, 25 * 60)] }), 1));
    await renderSheet();
    expect(document.querySelector('.log-total')).toBeNull();
    cleanup();
    stored = makeSettings({ layout: stored.layout.map((l) => (l.id === 'timeclock' ? { ...l, visible: false } : l)) });
    await renderSheet();
    expect(document.querySelector('.log-total')?.textContent).toMatch(/^Total focused.+· 1 session$/);
  });
});

describe("Sheet: the timeclock card's state", () => {
  it('shows the state beside the title, and none while the punches are out of order', async () => {
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { punches: punchesAt(T0 - 3 * HOUR_MS) }), 1));
    await renderSheet();
    expect(document.querySelector('.card-aside')?.textContent).toBe('Working');
    // The notice's live region is there, empty, before any punch is out of order.
    expect(document.querySelector('.punch-order[role="status"]')?.textContent).toBe('');
    cleanup();
    // Lunch in typed as 7:00, before the 8:00 Lunch out: the notice says so, and "Working" would be a guess.
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { punches: punchesAt(T0 - 3 * HOUR_MS, T0 - HOUR_MS, T0 - 2 * HOUR_MS) }), 1));
    await renderSheet();
    expect(document.querySelector('.card-aside')).toBeNull();
  });

  it('names the punch out of place in the notice, which describes that row', async () => {
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { punches: punchesAt(T0 - 3 * HOUR_MS, T0 - HOUR_MS, T0 - 2 * HOUR_MS) }), 1));
    await renderSheet();
    const notice = screen.getByText(PUNCH_ORDER('Lunch in', '7:00 AM', 'Lunch out', '8:00 AM'));
    // Inside a live region that is there before it appears, so a screen reader hears it.
    expect(notice.parentElement!.getAttribute('role')).toBe('status');
    const segments = (label: string) => within(screen.getByRole('group', { name: `${label} time` })).getAllByRole('spinbutton');
    for (const s of segments('Lunch in')) {
      expect(s.getAttribute('aria-invalid')).toBe('true');
      expect(s.getAttribute('aria-describedby')?.split(' ')).toContain(notice.id);
    }
    expect(segments('Lunch out').some((s) => s.hasAttribute('aria-invalid'))).toBe(false);
  });
});

describe('Sheet: the punch-order notice while a pair is typed in', () => {
  // Clocked in at 8:00, lunch from 12:00 to 12:30, a break from 10:00 to 10:15 (Out 1 / In 1, before
  // lunch) and, in the rows before it, an empty pair after lunch (Out 2 / In 2). Its Out typed as
  // 11:00 belongs before lunch, and leaves Lunch out with no In before it. The sheet is shown at
  // 13:00: until the clock reaches Lunch out, that slip waits.
  const AFTER_LUNCH_OUT = T0 + 4 * HOUR_MS;
  const punches = (out2: number | null) => punchesAt(T0 - HOUR_MS, T0 + 3 * HOUR_MS, T0 + 3.5 * HOUR_MS, out2, null, T0 + HOUR_MS, T0 + 1.25 * HOUR_MS);
  const labels = () => [...document.querySelectorAll('.punch-label')].map((l) => l.textContent);
  const focusOut2 = () =>
    act(() =>
      within(screen.getByRole('group', { name: 'Out 2 time' }))
        .getAllByRole('spinbutton')[0]!
        .focus(),
    );

  const pinned = ['Clock in', 'Out 1', 'In 1', 'Lunch out', 'Lunch in', 'Out 2', 'In 2', 'Clock out'];
  const unpinned = ['Clock in', 'Out 1', 'In 1', 'Out 2', 'In 2', 'Lunch out', 'Lunch in', 'Clock out'];

  /** Today's sheet with the focus in Out 2 and 11:00 stored there, brought back as the save would by the day store the sheet uses. */
  async function typeOut2() {
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { punches: punches(null) }), 1));
    const { result } = renderHook(() => useDayStore(), {
      wrapper: ({ children }) => (
        <AppProviders>
          <SheetAt now={AFTER_LUNCH_OUT} />
          {children}
        </AppProviders>
      ),
    });
    await settle();
    focusOut2();
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { punches: punches(T0 + 2 * HOUR_MS) }), 1));
    await act(() => result.current.refresh(TODAY));
    await settle();
  }

  it('names the rows as the card does, which keeps that pair in its place until the focus leaves it', async () => {
    await typeOut2();
    expect(labels()).toEqual(pinned);
    expect(screen.getByText(PUNCH_ORDER('Lunch out', '12:00 PM', 'In 2', null))).toBeTruthy();
    act(() => button('Now: Clock in').focus());
    expect(labels()).toEqual(unpinned);
    expect(screen.getByText(PUNCH_ORDER('Lunch out', '12:00 PM', 'In 1', null))).toBeTruthy();
  });

  it('lets the pair go when the card mounts again in the other column, the field gone with no blur', async () => {
    await typeOut2();
    stored = makeSettings({ layout: stored.layout.map((l) => (l.id === 'timeclock' ? { ...l, side: 'right' } : l)) });
    // Another device's move, which the settings read brings.
    await settle(6000);
    setVisibility('visible');
    await settle();
    expect(columns()[1]).toContain('Timeclock');
    expect(labels()).toEqual(unpinned);
    expect(screen.getByText(PUNCH_ORDER('Lunch out', '12:00 PM', 'In 1', null))).toBeTruthy();
  });

  it("lets the pair go when another day's sheet takes the card's place, and coming back finds it gone", async () => {
    let todayOut2: number | null = null;
    vi.mocked(api.getDay).mockImplementation((d) =>
      Promise.resolve(
        answered(makeDay(d, { punches: d === TODAY ? punches(todayOut2) : punches(T0 + 2 * HOUR_MS).map((p) => ({ ...p, at: p.at && p.at - DAY_MS })) }), 1),
      ),
    );
    const { rerender } = render(
      <AppProviders>
        <SheetAt now={AFTER_LUNCH_OUT} />
      </AppProviders>,
    );
    await settle();
    focusOut2();
    todayOut2 = T0 + 2 * HOUR_MS;
    // A new date mounts the card again, with no blur from the field that went.
    rerender(
      <AppProviders>
        <SheetAt date={YESTERDAY} now={AFTER_LUNCH_OUT} />
      </AppProviders>,
    );
    await settle();
    expect(labels()).toEqual(unpinned);
    expect(screen.getByText(PUNCH_ORDER('Lunch out', '12:00 PM', 'In 1', null))).toBeTruthy();
    rerender(
      <AppProviders>
        <SheetAt now={AFTER_LUNCH_OUT} />
      </AppProviders>,
    );
    await settle();
    expect(labels()).toEqual(unpinned);
    expect(screen.getByText(PUNCH_ORDER('Lunch out', '12:00 PM', 'In 1', null))).toBeTruthy();
  });
});

describe("Sheet: today's retrospective", () => {
  const retroNote = () => document.querySelector('#card-retro textarea');

  it('stays folded to its line until the Clock out is reached, then opens', async () => {
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { punches: punchesAt(T0 - 3 * HOUR_MS, null, null, T0 + 30 * MINUTE_MS) }), 1));
    const { rerender } = await renderSheet();
    expect(retroNote()).toBeNull();
    expect(document.querySelector('#card-retro .retro-folded')).not.toBeNull();
    rerender(
      <AppProviders>
        <SheetAt now={T0 + 30 * MINUTE_MS} />
      </AppProviders>,
    );
    expect(retroNote()).not.toBeNull();
  });

  it("shows another day's open", async () => {
    vi.mocked(api.getDay).mockImplementation((d) => Promise.resolve(answered(makeDay(d))));
    render(
      <AppProviders>
        <SheetAt date={YESTERDAY} />
      </AppProviders>,
    );
    await settle();
    expect(retroNote()).not.toBeNull();
  });
});

describe('Sheet: what the last day left open', () => {
  it('offers a task in Next or on no lane in the morning notice, leaves one parked in Later where it is, and waits for the board', async () => {
    serveRange([
      makeDay(YESTERDAY, {
        priorities: [
          makePriority(1, 'In Next', { uid: 'next00000001' }),
          makePriority(2, 'Parked since', { uid: 'later0000001' }),
          makePriority(3, 'On no lane'),
        ],
      }),
    ]);
    const board = deferredAnswer<Board>();
    vi.mocked(api.getBoard).mockReturnValue(board.promise);
    await renderSheet();
    expect(screen.queryByText(LEFT_OPEN.title('Yesterday'))).toBeNull();
    board.resolve(makeBoard(makeCard('next00000001', 'In Next', { lane: 'next' }), makeCard('later0000001', 'Parked since')));
    await settle();
    const offer = screen.getByText(LEFT_OPEN.title('Yesterday')).closest('.today-offer')!;
    expect([...offer.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['In Next', 'On no lane']);
    expect(screen.getByRole('button', { name: LEFT_OPEN.dismiss })).toBeTruthy();
  });

  it('offers nothing when every row it would bring back was moved off Next', async () => {
    serveRange([makeDay(YESTERDAY, { priorities: [makePriority(1, 'Parked', { uid: 'later0000001' })] })]);
    vi.mocked(api.getBoard).mockResolvedValue(answered(makeBoard(makeCard('later0000001', 'Parked'))));
    await renderSheet();
    expect(screen.queryByText(LEFT_OPEN.title('Yesterday'))).toBeNull();
    expect(document.querySelector('.left-open')).toBeNull();
  });

  // Without the board's copy, a task parked in Later or done there would be offered again.
  it('offers nothing while the board read fails, and the leftovers once a later read lands', async () => {
    serveRange([makeDay(YESTERDAY, { priorities: [makePriority(1, 'Invoices')] })]);
    vi.mocked(api.getBoard).mockRejectedValueOnce(new Error('offline'));
    await renderSheet();
    expect(screen.queryByText(LEFT_OPEN.title('Yesterday'))).toBeNull();
    await settle(MINUTE_MS);
    expect(screen.getByText(LEFT_OPEN.title('Yesterday'))).toBeTruthy();
  });

  it("offers the top of Next less the last plan's tasks once they are read, ticked to fill Rows per day, held by Start fresh, and added with each task kept in Next", async () => {
    serveOffer();
    vi.mocked(api.putPriorities).mockImplementation(echoPriorities);
    // Ticked on yesterday's sheet since the board was read, which still has it open in Next.
    const ticked = makePriority(2, 'Ticked yesterday', { uid: 'next00000001', done: true });
    const yesterday = makeDay(YESTERDAY, { priorities: [makePriority(1, 'Left open', { uid: 'next00000002' }), ticked] });
    const lookback = deferredAnswer<{ days: Day[] }>();
    vi.mocked(api.getRange).mockImplementation((_from, to) => (to === YESTERDAY ? lookback.promise : Promise.resolve(answered({ days: [] }))));
    const next = (n: number, title: string, patch = {}) => makeCard(`next0000000${n}`, title, { lane: 'next', position: n, ...patch });
    vi.mocked(api.getBoard).mockResolvedValue(
      answered(
        makeBoard(
          next(1, 'Ticked yesterday', { listDate: YESTERDAY }),
          next(2, 'Left open', { listDate: YESTERDAY }),
          makeCard('later0000001', 'Parked'),
          next(3, 'Follow up on the Acme SLA'),
          next(4, 'Draft the rota'),
          next(5, 'Write a KB'),
          next(6, 'Further down'),
        ),
      ),
    );
    await renderSheet();
    // Until the leftovers are read, a task left open could show in Up next first.
    expect(screen.queryByText(TODAY_OFFER.upNext)).toBeNull();
    lookback.resolve({ days: [yesterday] });
    await settle();
    expect(screen.getByRole('group', { name: LEFT_OPEN.title('Yesterday') }).textContent).toContain('Left open');
    const upNext = within(screen.getByRole('group', { name: TODAY_OFFER.upNext })).getAllByRole('checkbox') as HTMLInputElement[];
    expect(upNext.map((b) => [b.closest('li')!.textContent, b.checked])).toEqual([
      ['Follow up on the Acme SLA', true],
      ['Draft the rota', true],
      ['Write a KB', false],
    ]);
    fireEvent.click(button(LEFT_OPEN.dismiss));
    await settle();
    expect(api.putOffer).toHaveBeenCalledExactlyOnceWith(TODAY);
    cleanup();
    await renderSheet();
    expect(document.querySelector('.today-offer')).toBeNull();

    // A day not answered yet.
    serveOffer();
    serveRange([yesterday]);
    cleanup();
    await renderSheet();
    fireEvent.click(button(LEFT_OPEN.add));
    await settle();
    expect(vi.mocked(api.putPriorities).mock.lastCall![1].map((p) => p.uid)).toEqual(['next00000002', 'next00000003', 'next00000004']);
    // The list's save alone: the server keeps a task's lane when a list takes it up, as a pull does.
    expect(api.editItem).not.toHaveBeenCalled();
  });
});

describe('Sheet: the recurring priorities due today', () => {
  // TODAY is a Monday.
  const SATURDAY = makeRecurring('rcur00000002', 'Water the plants', { weekdays: [6] });
  const offered = () => [...document.querySelectorAll('.today-offer li')].map((li) => li.textContent);
  const reload = async () => {
    cleanup();
    await renderSheet();
  };

  beforeEach(() => {
    serveOffer();
    vi.mocked(api.getBoard).mockResolvedValue(answered({ ...makeBoard(), recurring: [SATURDAY, QUEUE] }));
    vi.mocked(api.putPriorities).mockImplementation(echoPriorities);
  });

  it('offers the ones due on its weekday, and nothing on a day whose offer was answered, which it reads nothing more for', async () => {
    await renderSheet();
    expect(offered()).toEqual(['Monitor the queue']);
    expect(screen.getByText(TODAY_OFFER.recurring)).toBeTruthy();
    expect(lookedBack()).toBe(true);
    // Answered on another device.
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { offerAnsweredAt: T0 }), 1));
    vi.mocked(api.getRange).mockClear();
    await reload();
    expect(document.querySelector('.today-offer')).toBeNull();
    expect(lookedBack()).toBe(false);
  });

  it("takes the notice down when a refresh brings another device's answer", async () => {
    // The day store the sheet uses, to read today again as the refresh loop or the live stream would.
    const { result } = renderHook(() => useDayStore(), {
      wrapper: ({ children }) => (
        <AppProviders>
          <SheetAt />
          {children}
        </AppProviders>
      ),
    });
    await settle();
    expect(offered()).toEqual(['Monitor the queue']);
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { offerAnsweredAt: T0 }), 2));
    await act(() => result.current.refresh(TODAY));
    await settle();
    expect(document.querySelector('.today-offer')).toBeNull();
  });

  it('holds the routines while the lookback read is out, and shows them once it fails', async () => {
    const lookback = deferredAnswer<{ days: Day[] }>();
    vi.mocked(api.getRange).mockImplementation((_from, to) => (to === YESTERDAY ? lookback.promise : Promise.resolve(answered({ days: [] }))));
    await renderSheet();
    expect(api.getBoard).toHaveBeenCalled();
    expect(document.querySelector('.today-offer')).toBeNull();
    lookback.reject(new Error('offline'));
    await settle();
    expect(offered()).toEqual(['Monitor the queue']);
  });

  it("stamps the day once Add to Today's save is in, and not when it fails, which offers again", async () => {
    const save = deferredAnswer<PrioritiesResponse>();
    vi.mocked(api.putPriorities).mockReturnValueOnce(save.promise).mockRejectedValueOnce(new Error('offline'));
    await renderSheet();
    fireEvent.click(button(LEFT_OPEN.add));
    await settle();
    expect(api.putOffer).not.toHaveBeenCalled();
    save.resolve({ priorities: vi.mocked(api.putPriorities).mock.calls[0]![1].filter((p) => p.uid != null) });
    await settle();
    expect(api.putOffer).toHaveBeenCalledExactlyOnceWith(TODAY);
    expect(document.querySelector('.today-offer')).toBeNull();

    serveOffer();
    await reload();
    fireEvent.click(button(LEFT_OPEN.add));
    await settle();
    expect(api.putPriorities).toHaveBeenCalledTimes(2);
    expect(api.putOffer).toHaveBeenCalledTimes(1);
    expect(offered()).toEqual(['Monitor the queue']);
  });

  it("brings the notice back and says so when Not today's stamp fails", async () => {
    vi.mocked(api.putOffer).mockRejectedValueOnce(new Error('offline'));
    await renderSheet();
    fireEvent.click(button(TODAY_OFFER.notToday));
    expect(document.querySelector('.today-offer')).toBeNull();
    await settle();
    expect(warnSaveFailed).toHaveBeenCalledTimes(1);
    expect(offered()).toEqual(['Monitor the queue']);
  });

  it("adds one after the padded rows, and doesn't offer it again once its row is removed, after a reload too", async () => {
    await renderSheet();
    fireEvent.click(button(LEFT_OPEN.add));
    await settle();
    expect(vi.mocked(api.putPriorities).mock.lastCall![1].map((p) => [p.text, p.uid, p.recurring])).toEqual([
      ['', null, false],
      ['', null, false],
      ['', null, false],
      ['Monitor the queue', QUEUE.uid, true],
    ]);
    expect(document.querySelector('.today-offer')).toBeNull();
    fireEvent.click(button('Remove priority 4'));
    await settle();
    expect(vi.mocked(api.putPriorities).mock.lastCall![1].some((p) => p.recurring)).toBe(false);
    expect(document.querySelector('.today-offer')).toBeNull();
    await reload();
    expect(document.querySelector('.today-offer')).toBeNull();
  });

  it('shows the leftovers beside them, and Not today stamps the day at once, saving no list', async () => {
    serveRange([makeDay(YESTERDAY, { priorities: [makePriority(1, 'Invoices')] })]);
    await renderSheet();
    expect(offered()).toEqual(['Invoices', 'Monitor the queue']);
    fireEvent.click(button(TODAY_OFFER.notToday));
    expect(document.querySelector('.today-offer')).toBeNull();
    await settle();
    expect(api.putOffer).toHaveBeenCalledExactlyOnceWith(TODAY);
    expect(api.putPriorities).not.toHaveBeenCalled();
    await reload();
    expect(document.querySelector('.today-offer')).toBeNull();
  });

  it('shows the routines with no lookback read while a one-off is written, and Not today then holds the leftovers too', async () => {
    serveRange([makeDay(YESTERDAY, { priorities: [makePriority(1, 'Invoices')] })]);
    serveOffer(makeDay(TODAY, { priorities: [makePriority(1, 'Report')] }));
    await renderSheet();
    expect(offered()).toEqual(['Monitor the queue']);
    expect(lookedBack()).toBe(false);
    fireEvent.click(button(TODAY_OFFER.notToday));
    await settle();
    expect(document.querySelector('.today-offer')).toBeNull();
    // With the one-off taken off the list has no plan, but the day is answered: nothing is offered or read.
    fireEvent.click(button('Remove priority 1'));
    await settle();
    expect(document.querySelector('.today-offer')).toBeNull();
    expect(lookedBack()).toBe(false);
  });

  it("offers nothing on another day's sheet, though today's routines are due", async () => {
    vi.mocked(api.getDay).mockImplementation((d) => Promise.resolve(answered(makeDay(d))));
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

  it('still offers the leftovers while the list holds only a routine, and not the routine it holds', async () => {
    vi.mocked(api.getDay).mockResolvedValue(
      answered(makeDay(TODAY, { priorities: [makePriority(1, 'Monitor the queue', { uid: QUEUE.uid, recurring: true })] }), 1),
    );
    serveRange([makeDay(YESTERDAY, { priorities: [makePriority(1, 'Invoices')] })]);
    await renderSheet();
    expect(offered()).toEqual(['Invoices']);
    expect(screen.queryByText(TODAY_OFFER.recurring)).toBeNull();
  });

  it("doesn't offer the leftovers again once a row Add to Today brought over is removed", async () => {
    vi.mocked(api.getBoard).mockResolvedValue(answered(makeBoard()));
    serveRange([makeDay(YESTERDAY, { priorities: [makePriority(1, 'Invoices')] })]);
    await renderSheet();
    fireEvent.click(button(LEFT_OPEN.add));
    await settle();
    expect(vi.mocked(api.putPriorities).mock.lastCall![1].map((p) => p.text)).toEqual(['Invoices', '', '']);
    fireEvent.click(button('Remove priority 1'));
    await settle();
    expect(document.querySelector('.today-offer')).toBeNull();
    await reload();
    expect(document.querySelector('.today-offer')).toBeNull();
  });
});

describe('Sheet: × on a task on other days', () => {
  it('deletes it everywhere through the board store', async () => {
    const email = makePriority(1, 'Email', { listed: 3 });
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { priorities: [email] }), 1));
    vi.mocked(api.putPriorities).mockImplementation(echoPriorities);
    vi.mocked(api.deleteItem).mockResolvedValue(answered(makeBoard()));
    await renderSheet();
    fireEvent.click(button('Remove priority 1'));
    fireEvent.click(button(REMOVE_TASK.everywhere));
    await settle();
    expect(vi.mocked(api.putPriorities).mock.lastCall![1].some((p) => p.uid === email.uid)).toBe(false);
    expect(api.deleteItem).toHaveBeenCalledExactlyOnceWith(email.uid);
  });
});

describe("Sheet: a row's note", () => {
  it('saves it on the list through the day store, and keeps it in its box when the save fails', async () => {
    const report = makePriority(1, 'Report', { note: 'Kim has the numbers.' });
    const noteOf = (rows: { uid: string | null; note: string }[]) => rows.find((p) => p.uid === report.uid)?.note;
    const box = () => screen.getByRole('textbox', { name: 'Note for priority 1' }) as HTMLTextAreaElement;
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { priorities: [report] }), 1));
    vi.mocked(api.putPriorities).mockImplementation(echoPriorities);
    await renderSheet();
    fireEvent.click(button('Note for priority 1'));
    fireEvent.change(box(), { target: { value: 'Kim has them.' } });
    await settle(400);
    const [, list, base] = vi.mocked(api.putPriorities).mock.lastCall!;
    expect([noteOf(list), noteOf(base)]).toEqual(['Kim has them.', 'Kim has the numbers.']);
    vi.mocked(api.putPriorities).mockRejectedValueOnce(new Error('offline'));
    fireEvent.change(box(), { target: { value: 'Kim has them all.' } });
    await settle(400);
    expect(warnSaveFailed).toHaveBeenCalledOnce();
    expect(box().value).toBe('Kim has them all.');
    fireEvent.blur(box());
    await settle();
    expect(api.putPriorities).toHaveBeenCalledTimes(3);
    expect(noteOf(vi.mocked(api.putPriorities).mock.lastCall![1])).toBe('Kim has them all.');
  });

  it("sends it to the task when the row has left the day's list before the box's save", async () => {
    const report = makePriority(1, 'Report', { listed: 2 });
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { priorities: [report] }), 1));
    vi.mocked(api.editItem).mockResolvedValue(answered(makeBoard()));
    // The day store the sheet uses, to read the day again as the refresh loop would.
    const { result } = renderHook(() => useDayStore(), {
      wrapper: ({ children }) => (
        <AppProviders>
          <SheetAt />
          {children}
        </AppProviders>
      ),
    });
    await settle();
    fireEvent.click(button('Add a note to priority 1'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Note for priority 1' }), { target: { value: 'Kim has the numbers.' } });
    // Another device took it off this day: the read drops the row, and its box goes with it, unsent.
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY), 1));
    await act(() => result.current.refresh(TODAY));
    await settle();
    expect(screen.queryByRole('textbox', { name: 'Note for priority 1' })).toBeNull();
    expect(api.putPriorities).not.toHaveBeenCalled();
    expect(api.editItem).toHaveBeenCalledExactlyOnceWith(report.uid, { note: 'Kim has the numbers.' });
    expect(warnSaveFailed).not.toHaveBeenCalled();
  });

  it('raises no banner when × takes the task before the box saved and the task goes with it', async () => {
    const report = makePriority(1, 'Report');
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { priorities: [report] }), 1));
    vi.mocked(api.putPriorities).mockImplementation(echoPriorities);
    // The list's save without the row deleted the task, which nothing else names.
    vi.mocked(api.editItem).mockRejectedValue(new ApiError(404, 'Not found'));
    await renderSheet();
    fireEvent.click(button('Add a note to priority 1'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Note for priority 1' }), { target: { value: 'Kim has the numbers.' } });
    // A tap that leaves the focus in the box, so nothing saves it before ×.
    fireEvent.click(button('Remove priority 1'));
    await settle();
    expect(vi.mocked(api.putPriorities).mock.lastCall![1].some((p) => p.uid === report.uid)).toBe(false);
    expect(api.editItem).toHaveBeenCalledExactlyOnceWith(report.uid, { note: 'Kim has the numbers.' });
    expect(warnSaveFailed).not.toHaveBeenCalled();
  });
});

describe("Sheet: a category's chip", () => {
  const day = makeDay(TODAY, {
    priorities: [makePriority(1, 'Report', { categoryUid: TICKETS.uid })],
    sessions: [completedSession(1, T0 - HOUR_MS, 25 * 60, { label: 'Inbox', categoryUid: ADMIN.uid })],
  });
  const chips = () => screen.queryAllByRole('button', { name: /^Category for / }).map((b) => b.getAttribute('aria-label'));

  beforeEach(() => {
    vi.mocked(api.getDay).mockResolvedValue(answered(day, 1));
    vi.mocked(api.getBoard).mockResolvedValue(answered({ ...makeBoard(), categories: [TICKETS, ADMIN] }));
    vi.mocked(api.putPriorities).mockImplementation(echoPriorities);
  });

  it("gives a priority row, the timer's new row and the log the board's categories", async () => {
    await renderSheet();
    expect(chips()).toEqual(['Category for priority 1: Tickets']);
    expect(screen.getByRole('img', { name: 'Admin' })).toBeTruthy();

    fireEvent.change(screen.getByRole('combobox', { name: 'Session label' }), { target: { value: 'Call the vendor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Category for the new priority: none' }));
    fireEvent.click(screen.getByRole('option', { name: 'Admin' }));
    vi.mocked(api.startSession).mockReturnValue(new Promise(() => {}));
    fireEvent.click(screen.getByRole('button', { name: /^25\s*min$/ }));
    await settle();
    expect(vi.mocked(api.putPriorities).mock.lastCall![1][1]).toMatchObject({ text: 'Call the vendor', categoryUid: ADMIN.uid });
  });
});
