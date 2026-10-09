// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atTime, MINUTE_MS } from '../../../shared/dates.js';
import * as api from '../api';
import { LOAD_FAILED } from '../lib/copy';
import type { ReviewPeriod } from '../lib/review';
import {
  completedSession,
  deferred,
  makeBoard,
  makeBreak,
  makeCategory,
  makeDay,
  makePriority,
  makeCard,
  makeSettings,
  punchesAt,
  serveRange,
  SettingsAndDays,
  settle,
} from '../test/hooks';
import type { Board } from '../types';
import { Review } from './Review';

vi.mock('../api');

const TODAY = '2026-09-30';
const NOW = new Date(2026, 8, 30, 17).getTime();
const MON = '2026-09-28';
const TUE = '2026-09-29';

/**
 * Monday: 8 h worked, 50m on the first row and 10m off the plan, a 10-minute break, and a second
 * row written at 11:00, after the first session. Tuesday: a 4 h half day clocked out an hour
 * early, with three rows written before work and one ticked, and no sessions.
 */
const mon = makeDay(MON, {
  punches: punchesAt(atTime(MON, 8, 0), atTime(MON, 12, 0), atTime(MON, 12, 30), atTime(MON, 16, 30)),
  priorities: [makePriority(1, 'Ship it', { done: true, addedAt: 0 }), makePriority(2, 'Call the bank', { addedAt: atTime(MON, 11, 0) })],
  sessions: [
    completedSession(1, atTime(MON, 9, 0), 3000, { date: MON, priorityUid: makePriority(1, '').uid }),
    completedSession(2, atTime(MON, 14, 0), 600, { date: MON }),
  ],
  breaks: [makeBreak({ date: MON, plannedSeconds: 600, startedAt: atTime(MON, 9, 50), endedAt: atTime(MON, 10, 0) })],
});
const tue = makeDay(TUE, {
  workMinutes: 240,
  punches: punchesAt(atTime(TUE, 8, 0), null, null, atTime(TUE, 11, 0)),
  priorities: [
    makePriority(1, 'Write the report', { addedAt: 0 }),
    makePriority(2, 'File expenses', { done: true, addedAt: 0 }),
    makePriority(3, 'Plan Q4', { addedAt: 0 }),
  ],
});

/** The facts strip's lines, in order. */
const facts = () => [...document.querySelectorAll('.review-facts li')].map((li) => li.textContent);
/** The sections under the tiles, by their headings' own text (without the muted count). */
const sections = () => [...document.querySelectorAll('.review-section .section-heading')].map((h) => h.firstChild?.textContent?.trim());
/** A section's rows: each one's text, then its meta's parts. */
const rows = (heading: string) => {
  const section = [...document.querySelectorAll('.review-section')].find(
    (s) => s.querySelector('.section-heading')?.firstChild?.textContent?.trim() === heading,
  );
  return [...(section?.querySelectorAll('.review-row') ?? [])].map((row) => [
    row.querySelector('.review-text')?.textContent,
    ...[...row.querySelectorAll('.review-meta > *')].map((m) => m.textContent),
  ]);
};

/**
 * By category's rows: each one's dot colour, name, muted parts and time, and its bar (null for
 * none): its colour, whether it is No category's, its width and its on and off parts' widths.
 */
const categoryRows = () =>
  [...document.querySelectorAll('.review-category')].map((row) => {
    const bar = row.querySelector<HTMLElement>('.category-bar');
    const part = (kind: string) => bar?.querySelector<HTMLElement>(`.category-bar-${kind}`)?.style.width ?? null;
    return {
      dot: row.querySelector('.cat-dot')?.getAttribute('data-color') ?? null,
      name: row.querySelector('.review-text')?.textContent,
      parts: [...row.querySelectorAll('.review-category-parts > *')].map((p) => p.textContent),
      time: row.querySelector('.review-time')?.textContent,
      bar: bar && {
        color: bar.getAttribute('data-color'),
        none: bar.classList.contains('category-bar--none'),
        width: bar.style.width,
        on: part('on'),
        off: part('off'),
      },
    };
  });

async function review(period: ReviewPeriod, onOpen = vi.fn()) {
  const onPeriod = vi.fn();
  render(
    <SettingsAndDays>
      <Review today={TODAY} now={NOW} period={period} onPeriod={onPeriod} onOpen={onOpen} />
    </SettingsAndDays>,
  );
  await settle();
  return onPeriod;
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  vi.mocked(api.getSettings).mockResolvedValue(makeSettings());
  vi.mocked(api.getRange).mockResolvedValue({ days: [] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Review', () => {
  it('shows a failed load with Try again, which loads the review', async () => {
    vi.mocked(api.getRange).mockRejectedValueOnce(new Error('Request failed (502)'));
    await review({ kind: 'week', from: '2026-09-28' });
    expect(screen.getByRole('alert').textContent).toContain(LOAD_FAILED.range);
    fireEvent.click(screen.getByRole('button', { name: LOAD_FAILED.retry }));
    await settle();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Nothing recorded.')).toBeTruthy();
    expect(api.getRange).toHaveBeenCalledTimes(2);
  });

  it('turns a past week into the month it ends in', async () => {
    // Monday 29 June to Sunday 5 July: the month it starts in would be June.
    const onPeriod = await review({ kind: 'week', from: '2026-06-29' });
    fireEvent.click(screen.getByRole('button', { name: 'Month' }));
    expect(onPeriod).toHaveBeenCalledWith({ kind: 'month', from: '2026-07-01' });
  });

  it('keeps the current period current when the kind changes', async () => {
    // This week runs into October; its month is still September, the month today is in.
    const fromWeek = await review({ kind: 'week', from: '2026-09-28' });
    fireEvent.click(screen.getByRole('button', { name: 'Month' }));
    expect(fromWeek).toHaveBeenCalledWith({ kind: 'month', from: '2026-09-01' });
    cleanup();

    const fromMonth = await review({ kind: 'month', from: '2026-09-01' });
    fireEvent.click(screen.getByRole('button', { name: 'Week' }));
    expect(fromMonth).toHaveBeenCalledWith({ kind: 'week', from: '2026-09-28' });
  });

  it('steps from the period on screen and resets to the current one', async () => {
    const onPeriod = await review({ kind: 'week', from: '2026-07-13' });
    fireEvent.click(screen.getByRole('button', { name: 'Previous week' }));
    expect(onPeriod).toHaveBeenLastCalledWith({ kind: 'week', from: '2026-07-06' });
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    expect(onPeriod).toHaveBeenLastCalledWith({ kind: 'week', from: '2026-07-20' });
    fireEvent.click(screen.getByRole('button', { name: 'This week' }));
    expect(onPeriod).toHaveBeenLastCalledWith({ kind: 'week', from: '2026-09-28' });
    cleanup();

    // The current period has no next and no reset.
    await review({ kind: 'quarter', from: '2026-07-01' });
    expect((screen.getByRole('button', { name: 'Next quarter' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'This quarter' })).toBeNull();
  });

  it('holds a week to the Work week, counts its sessions and lists the facts under the tiles', async () => {
    serveRange([mon, tue]);
    await review({ kind: 'week', from: MON });
    // The half day doesn't lower a week's target.
    expect(screen.getByText('worked 11h 00m of 40h 00m')).toBeTruthy();
    expect(screen.getByText('2 sessions · 83% on plan')).toBeTruthy();
    expect(facts()).toEqual(['Added mid-day: 1 · 0 done', 'Breaks: 1 · 10m', 'Typical day: 3 planned · 1 done']);
    // Straight after the tiles, before Off the plan.
    expect(document.querySelector('.tiles + .review-facts + .review-section')).not.toBeNull();
    // No routine on the lists, so no Routines section.
    expect(sections()).toEqual(['Off the plan', 'Not done', 'Why']);
  });

  it('lists the routines between Off the plan and Not done, each as the days ticked of the days on the list', async () => {
    const QUEUE = 'rcur00000001';
    const routineMon = makeDay(MON, {
      priorities: [
        makePriority(1, 'Ship it', { done: true, addedAt: 0 }),
        makePriority(2, 'Monitor the queue', { uid: QUEUE, recurring: true, done: true, addedAt: 0 }),
        makePriority(3, 'Follow-ups', { uid: 'rcur00000002', recurring: true, addedAt: 0 }),
      ],
      sessions: [completedSession(1, atTime(MON, 9, 0), 3000, { date: MON, priorityUid: QUEUE })],
    });
    const routineTue = makeDay(TUE, {
      priorities: [makePriority(1, 'Write the report', { addedAt: 0 }), makePriority(2, 'Monitor the queue', { uid: QUEUE, recurring: true, addedAt: 0 })],
    });
    serveRange([routineMon, routineTue]);
    const onOpen = vi.fn();
    await review({ kind: 'week', from: MON }, onOpen);
    expect(sections()).toEqual(['Off the plan', 'Routines', 'Not done', 'Why']);
    expect(screen.getByText('Routines').querySelector('.muted')?.textContent).toBe('2');
    expect(rows('Routines')).toEqual([
      ['Monitor the queue', '1 of 2 days', '50m'],
      ['Follow-ups', '0 of 1 day', 'no time'],
    ]);
    // The routines missed are not left open; the one-off is. The tile counts them all.
    expect(rows('Not done')).toEqual([['Write the report', 'Tue', 'no time']]);
    expect(screen.getByText('2/5')).toBeTruthy();
    // A routine opens its latest day.
    fireEvent.click(screen.getByRole('button', { name: /Monitor the queue/ }));
    expect(onOpen).toHaveBeenCalledWith(TUE);
  });

  it('says nothing outside the routines was left open once every one-off is ticked', async () => {
    serveRange([
      makeDay(MON, {
        priorities: [makePriority(1, 'Ship it', { done: true }), makePriority(2, 'Monitor the queue', { uid: 'rcur00000001', recurring: true })],
      }),
    ]);
    await review({ kind: 'week', from: MON });
    expect(screen.getByText('Nothing outside the routines was left open.')).toBeTruthy();
    expect(screen.queryByText('Every priority got ticked.')).toBeNull();
    cleanup();

    serveRange([makeDay(MON, { priorities: [makePriority(1, 'Ship it', { done: true })] })]);
    await review({ kind: 'week', from: MON });
    expect(screen.getByText('Every priority got ticked.')).toBeTruthy();
  });

  it('joins a one-off retyped on a later day to the first in Not done, unless the board holds the later one in a lane', async () => {
    serveRange([
      makeDay(MON, { priorities: [makePriority(1, 'Email Bob', { uid: 'emailmon0001' })] }),
      makeDay(TUE, { priorities: [makePriority(1, 'email bob', { uid: 'emailtue0001' })] }),
    ]);
    await review({ kind: 'week', from: MON });
    expect(rows('Not done')).toEqual([['email bob', 'Mon, Tue', 'no time']]);
    cleanup();

    vi.mocked(api.getSettings).mockResolvedValue(makeSettings({ board: true }));
    vi.mocked(api.getBoard).mockResolvedValue(makeBoard(makeCard('emailtue0001', 'email bob', { lane: 'next' })));
    await review({ kind: 'week', from: MON });
    expect(rows('Not done')).toEqual([
      ['Email Bob', 'Mon', 'no time'],
      ['email bob', 'Tue', 'no time'],
    ]);
  });

  it("holds a month or a quarter to its days' own lengths, and leaves the typical day out of a quarter", async () => {
    serveRange([mon, tue]);
    await review({ kind: 'month', from: '2026-09-01' });
    // 8 h and the half day's 4 h, though Tuesday worked 3 h of its 4.
    expect(screen.getByText('worked 11h 00m of 12h 00m')).toBeTruthy();
    expect(facts()).toEqual(['Added mid-day: 1 · 0 done', 'Breaks: 1 · 10m', 'Typical day: 3 planned · 1 done']);
    cleanup();

    await review({ kind: 'quarter', from: '2026-07-01' });
    expect(screen.getByText('worked 11h 00m of 12h 00m')).toBeTruthy();
    expect(facts()).toEqual(['Added mid-day: 1 · 0 done', 'Breaks: 1 · 10m']);
  });

  it('counts a session that logged no time, with no on-plan share', async () => {
    // Finished within its first second: the server logs 0 seconds.
    const start = atTime(MON, 9, 0);
    const uid = makePriority(1, '').uid;
    serveRange([
      makeDay(MON, {
        priorities: [makePriority(1, 'Ship it')],
        sessions: [completedSession(1, start, 1500, { date: MON, priorityUid: uid, endedAt: start, durationSeconds: 0 })],
      }),
    ]);
    await review({ kind: 'week', from: MON });
    expect(screen.getByText('Focused').parentElement?.querySelector('.tile-sub')?.textContent).toBe('1 session');
    expect(screen.getByText('Every logged session was for a priority.')).toBeTruthy();
    expect(screen.queryByText('No sessions logged.')).toBeNull();
  });

  it('drops the target with no Work week, the hours with Show hours off, and the facts strip with nothing in it', async () => {
    serveRange([makeDay(MON, { punches: punchesAt(atTime(MON, 8, 0), null, null, atTime(MON, 12, 0)) })]);
    vi.mocked(api.getSettings).mockResolvedValue(makeSettings({ weekMinutes: 0 }));
    await review({ kind: 'week', from: MON });
    expect(screen.getByText('worked 4h 00m')).toBeTruthy();
    expect(screen.getByText('no sessions')).toBeTruthy();
    expect(document.querySelector('.review-facts')).toBeNull();
    cleanup();

    vi.mocked(api.getSettings).mockResolvedValue(makeSettings({ trackHours: false }));
    await review({ kind: 'week', from: MON });
    expect(screen.getByText('Days')).toBeTruthy();
    expect(screen.queryByText(/^worked/)).toBeNull();
  });
});

describe('Review: By category', () => {
  const TICKETS = makeCategory('cat000000001', 'Tickets');
  const ADMIN = makeCategory('cat000000002', 'Admin', { color: 'teal' });
  // Removed since: the time logged under it keeps its name.
  const KB = makeCategory('cat000000003', 'Knowledge base', { color: 'gold', archived: true });
  // Not one the board has.
  const GONE = 'cat0000000ff';
  const QUEUE = 'rcur00000001';
  const uid = (position: number) => makePriority(position, '').uid;
  /**
   * Tickets: 45m on a written row (ticked) and 15m on a task taken off the day, plus a row
   * written at 11:00, after the first session. Admin: 30m on no row. Knowledge base: a tick and no time. No
   * category: 15m on a row in a category the board doesn't have. A routine no one focused on.
   */
  const day = makeDay(MON, {
    priorities: [
      makePriority(1, 'Ship it', { categoryUid: TICKETS.uid, done: true, addedAt: 0 }),
      makePriority(3, 'Update the KB', { categoryUid: KB.uid, done: true, addedAt: 0 }),
      makePriority(4, 'Read the RFC', { categoryUid: GONE, addedAt: 0 }),
      makePriority(5, 'Fire drill', { categoryUid: TICKETS.uid, addedAt: atTime(MON, 11, 0) }),
      makePriority(6, 'Monitor the queue', { uid: QUEUE, recurring: true, addedAt: 0 }),
    ],
    sessions: [
      completedSession(1, atTime(MON, 9, 0), 45 * 60, { date: MON, priorityUid: uid(1) }),
      completedSession(2, atTime(MON, 10, 0), 15 * 60, { date: MON, priorityUid: 'leftday00001', title: 'Left the day', categoryUid: TICKETS.uid }),
      completedSession(3, atTime(MON, 11, 0), 30 * 60, { date: MON, label: 'Inbox', categoryUid: ADMIN.uid }),
      completedSession(4, atTime(MON, 12, 0), 15 * 60, { date: MON, priorityUid: uid(4) }),
    ],
  });
  const board: Board = { ...makeBoard(), categories: [TICKETS, ADMIN, KB] };
  const boardOn = () => vi.mocked(api.getSettings).mockResolvedValue(makeSettings({ board: true }));

  beforeEach(() => {
    serveRange([day]);
    vi.mocked(api.getBoard).mockResolvedValue(board);
  });

  it('shows nothing by category with the board off', async () => {
    await review({ kind: 'week', from: MON });
    expect(sections()).toEqual(['Off the plan', 'Routines', 'Not done', 'Why']);
    expect(document.querySelector('.review-category')).toBeNull();
    expect(facts()[0]).toBe('Added mid-day: 1 · 0 done');
    expect(rows('Routines')[0]![0]).toBe('Monitor the queue');
    expect(api.getBoard).not.toHaveBeenCalled();
  });

  it('lists the time and ticks by category after the facts, its bar solid on plan and striped off it, no category last', async () => {
    boardOn();
    await review({ kind: 'week', from: MON });
    expect(sections()).toEqual(['By category', 'Off the plan', 'Routines', 'Not done', 'Why']);
    expect(document.querySelector('.tiles + .review-facts + .review-section .review-category')).not.toBeNull();
    // Each bar against Tickets' hour; its parts against the bar.
    expect(categoryRows()).toEqual([
      {
        dot: 'blue',
        name: 'Tickets',
        parts: ['15m off the plan', '1 done'],
        time: '1h 00m',
        bar: { color: 'blue', none: false, width: '100%', on: '75%', off: '25%' },
      },
      { dot: 'teal', name: 'Admin', parts: ['30m off the plan'], time: '30m', bar: { color: 'teal', none: false, width: '50%', on: null, off: '100%' } },
      { dot: 'gold', name: 'Knowledge base', parts: ['1 done'], time: 'no time', bar: null },
      { dot: null, name: 'No category', parts: [], time: '15m', bar: { color: null, none: true, width: '25%', on: '100%', off: null } },
    ]);
    // A name is never drawn in its colour, and the bars are left to the text for a screen reader.
    for (const name of document.querySelectorAll('.review-category .review-text')) expect(name.closest('[data-color]')).toBeNull();
    expect(document.querySelectorAll('.category-bar:not([aria-hidden="true"])')).toHaveLength(0);
    expect(document.querySelectorAll('.review-category .cat-dot')).toHaveLength(3);
    // Its rows open nothing.
    expect(document.querySelector('.review-category button')).toBeNull();
  });

  it('names the category most rows added mid-day had', async () => {
    boardOn();
    await review({ kind: 'week', from: MON });
    expect(facts()[0]).toBe('Added mid-day: 1 · 0 done · mostly Tickets');
  });

  it('leaves out an off-plan part under a minute, and the parts line with nothing in it', async () => {
    boardOn();
    const offFor = (seconds: number, done = false) =>
      makeDay(MON, {
        priorities: [makePriority(1, 'Ship it', { categoryUid: TICKETS.uid, done, addedAt: 0 })],
        sessions: [
          completedSession(1, atTime(MON, 9, 0), 25 * 60, { date: MON, priorityUid: uid(1) }),
          completedSession(2, atTime(MON, 10, 0), seconds, { date: MON, label: 'Inbox', categoryUid: TICKETS.uid }),
        ],
      });
    serveRange([offFor(59)]);
    await review({ kind: 'week', from: MON });
    expect(document.querySelector('.review-category')).not.toBeNull();
    expect(document.querySelector('.review-category-parts')).toBeNull();
    cleanup();

    serveRange([offFor(59, true)]);
    await review({ kind: 'week', from: MON });
    expect(categoryRows().map((c) => c.parts)).toEqual([['1 done']]);
    cleanup();

    serveRange([offFor(60)]);
    await review({ kind: 'week', from: MON });
    expect(categoryRows().map((c) => c.parts)).toEqual([['1m off the plan']]);
  });

  it("sizes each bar against the largest category's time, no category's included", async () => {
    boardOn();
    serveRange([
      makeDay(MON, {
        priorities: [makePriority(1, 'Ship it', { categoryUid: TICKETS.uid, addedAt: 0 }), makePriority(2, 'Call the bank', { addedAt: 0 })],
        sessions: [
          completedSession(1, atTime(MON, 9, 0), 30 * 60, { date: MON, priorityUid: uid(1) }),
          completedSession(2, atTime(MON, 10, 0), 60 * 60, { date: MON, priorityUid: uid(2) }),
          completedSession(3, atTime(MON, 11, 0), 15 * 60, { date: MON, label: 'Inbox', categoryUid: ADMIN.uid }),
        ],
      }),
    ]);
    await review({ kind: 'week', from: MON });
    expect(categoryRows().map((c) => [c.name, c.bar?.width])).toEqual([
      ['Tickets', '50%'],
      ['Admin', '25%'],
      ['No category', '100%'],
    ]);
  });

  it('shows no section when nothing in the period has a category', async () => {
    boardOn();
    serveRange([mon, tue]);
    await review({ kind: 'week', from: MON });
    expect(sections()).toEqual(['Off the plan', 'Not done', 'Why']);
    expect(facts()[0]).toBe('Added mid-day: 1 · 0 done');
  });

  it("waits for the board's first read, and shows what the board off shows when that read fails", async () => {
    boardOn();
    const read = deferred<Board>();
    vi.mocked(api.getBoard).mockReturnValue(read.promise);
    await review({ kind: 'week', from: MON });
    expect(sections()[0]).toBe('Off the plan');
    expect(facts()[0]).toBe('Added mid-day: 1 · 0 done');
    read.resolve(board);
    await settle();
    expect(sections()[0]).toBe('By category');
    expect(facts()[0]).toBe('Added mid-day: 1 · 0 done · mostly Tickets');
    cleanup();

    vi.mocked(api.getBoard).mockRejectedValue(new Error('Request failed (502)'));
    await review({ kind: 'week', from: MON });
    expect(sections()).toEqual(['Off the plan', 'Routines', 'Not done', 'Why']);
    expect(facts()[0]).toBe('Added mid-day: 1 · 0 done');
    expect(rows('Routines')[0]![0]).toBe('Monitor the queue');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('goes back to no categories once the board is switched off, though the board is still held', async () => {
    boardOn();
    await review({ kind: 'week', from: MON });
    expect(sections()[0]).toBe('By category');
    // Switched off on another device: the settings are read again a minute later.
    vi.mocked(api.getSettings).mockResolvedValue(makeSettings());
    await settle(MINUTE_MS);
    expect(sections()).toEqual(['Off the plan', 'Routines', 'Not done', 'Why']);
    expect(facts()[0]).toBe('Added mid-day: 1 · 0 done');
    expect(rows('Routines')[0]![0]).toBe('Monitor the queue');
  });

  it('folds a long list after eight rows', async () => {
    boardOn();
    const categories = Array.from({ length: 10 }, (_, i) => makeCategory(`cat00000000${i}`, `Category ${i}`));
    vi.mocked(api.getBoard).mockResolvedValue({ ...board, categories });
    serveRange([makeDay(MON, { priorities: categories.map((c, i) => makePriority(i + 1, `Row ${i}`, { categoryUid: c.uid, done: true, addedAt: 0 })) })]);
    await review({ kind: 'week', from: MON });
    expect(categoryRows()).toHaveLength(8);
    fireEvent.click(screen.getByRole('button', { name: 'Show all 10' }));
    expect(categoryRows().map((c) => c.name)).toEqual(categories.map((c) => c.name));
  });
});
