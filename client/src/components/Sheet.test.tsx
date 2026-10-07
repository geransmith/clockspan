// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { SPLIT_QUERY } from '../lib/layout';
import { AppProviders, makeDay, makeSettings, serveRange, settle, T0, TODAY } from '../test/hooks';
import type { Settings } from '../types';
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

function SheetAt({ now = T0, customize = false }: { now?: number; customize?: boolean }) {
  return <Sheet date={TODAY} today={TODAY} now={now} customize={customize} jumpTo={null} onJumped={() => {}} onPunchEditing={() => {}} />;
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
