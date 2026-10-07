import { describe, expect, it } from 'vitest';
import { atTime, MINUTE_MS } from '../../../shared/dates.js';
import { completedSession, makeBreak, makeDay, makePriority, makeSession, punchesAt, TEST_SETTINGS, type EndPatch } from '../test/fixtures';
import { periodRange, periodTarget, reviewRange } from './review';
import type { Day } from '../types';

const FIRST_UID = makePriority(1, '').uid;
const SECOND_UID = makePriority(2, '').uid;

const settings = TEST_SETTINGS;
const at = (key: string, h: number, m = 0) => atTime(key, h, m);
// makePriority stamps a row at T0, after these days' sessions, so a row that must not read as added mid-day passes this.
const BEFORE_WORK = { addedAt: 0 };
const session = (id: number, date: string, startedAt: number, seconds: number, extra: EndPatch = {}) =>
  completedSession(id, startedAt, seconds, { date, ...extra });
/** A break planned for `minutes` from `startedAt`, ended at `endedAt`: its planned end unless cut short. */
const brk = (id: number, date: string, startedAt: number, minutes: number, endedAt = startedAt + minutes * MINUTE_MS) =>
  makeBreak({ id, date, plannedSeconds: minutes * 60, startedAt, endedAt });
/** A day with `total` written rows, the first `done` of them ticked. */
const planned = (date: string, total: number, done: number) =>
  makeDay(date, { priorities: Array.from({ length: total }, (_, i) => makePriority(i + 1, `Row ${i + 1}`, { done: i < done })) });

describe('periodRange', () => {
  it('steps weeks, months and quarters back from today', () => {
    expect(periodRange('week', '2026-09-16', 0)).toMatchObject({ from: '2026-09-14', to: '2026-09-20' });
    expect(periodRange('week', '2026-09-16', 1)).toMatchObject({ from: '2026-09-07', to: '2026-09-13' });
    expect(periodRange('month', '2026-09-16', 0)).toMatchObject({ from: '2026-09-01', to: '2026-09-30' });
    expect(periodRange('month', '2026-03-16', 1)).toMatchObject({ from: '2026-02-01', to: '2026-02-28' });
    expect(periodRange('quarter', '2026-09-16', 0)).toMatchObject({ from: '2026-07-01', to: '2026-09-30', label: 'Q3 2026' });
    expect(periodRange('quarter', '2026-02-01', 1)).toMatchObject({ from: '2025-10-01', to: '2025-12-31', label: 'Q4 2025' });
  });
});

describe('reviewRange', () => {
  const now = at('2026-09-16', 17);
  const d1 = makeDay('2026-09-14', {
    punches: punchesAt(at('2026-09-14', 8), at('2026-09-14', 12), at('2026-09-14', 12, 30), at('2026-09-14', 16, 30)),
    priorities: [makePriority(1, 'Ship it', { done: true }), makePriority(2, 'Write the proposal', BEFORE_WORK)],
    sessions: [
      session(1, '2026-09-14', at('2026-09-14', 9), 3000, { priorityUid: FIRST_UID }),
      session(2, '2026-09-14', at('2026-09-14', 14), 1200, { label: 'Fire drill' }),
    ],
    retroNote: '\nSlack ate the afternoon.\n\n',
    retroAt: at('2026-09-14', 16),
  });
  const d2 = makeDay('2026-09-15', {
    priorities: [makePriority(1, 'Call the bank', { done: true })],
    sessions: [
      session(3, '2026-09-15', at('2026-09-15', 9), 600, { priorityUid: FIRST_UID }),
      session(4, '2026-09-15', at('2026-09-15', 10), 2400, { label: 'Help Sam' }),
    ],
  });
  const empty = makeDay('2026-09-16');

  it('rolls days up and lists where the time went instead', () => {
    const r = reviewRange([d2, empty, d1], settings, '2026-09-16', now);
    expect(r.days).toBe(2);
    expect(r.workedSeconds).toBe(8 * 3600);
    // Only the Monday was clocked in, on the usual 8 h day.
    expect(r.targetSeconds).toBe(8 * 3600);
    expect(r.focusedSeconds).toBe(7200);
    expect(r.sessions).toBe(4);
    expect(r.offPlanSeconds).toBe(3600);
    expect(r.onPlanPercent).toBe(50);
    expect(r.prioritiesDone).toBe(2);
    expect(r.prioritiesTotal).toBe(3);
    expect(r.retrosDone).toBe(1);
    expect(r.unplanned.map((u) => [u.label, u.dates])).toEqual([
      ['Help Sam', ['2026-09-15']],
      ['Fire drill', ['2026-09-14']],
    ]);
    expect(r.notDone).toEqual([{ key: 'text:write the proposal', text: 'Write the proposal', dates: ['2026-09-14'], focusedSeconds: 0, addedMidDay: false }]);
    // The note as typed, without the blank lines around it.
    expect(r.notes).toEqual([{ date: '2026-09-14', note: 'Slack ate the afternoon.', reviewedAt: d1.retroAt }]);
  });

  it('leaves out a day after today, such as the next day planned tonight', () => {
    const tomorrow = makeDay('2026-09-17', {
      priorities: [makePriority(1, 'Write the proposal'), makePriority(2, 'Plan ahead')],
      sessions: [session(9, '2026-09-17', at('2026-09-17', 9), 600, { label: 'Early' })],
      retroNote: 'x',
    });
    expect(reviewRange([tomorrow], settings, '2026-09-16', now).days).toBe(0);
    expect(reviewRange([d2, empty, d1, tomorrow], settings, '2026-09-16', now)).toEqual(reviewRange([d2, empty, d1], settings, '2026-09-16', now));
  });

  it('counts a day that was only marked reviewed', () => {
    const reviewed = makeDay('2026-09-16', { retroAt: at('2026-09-16', 16) });
    expect(reviewRange([reviewed], settings, '2026-09-16', now)).toMatchObject({ days: 1, retrosDone: 1, workedSeconds: 0, notes: [] });
  });

  it('settles a priority ticked on a later day', () => {
    const mon = makeDay('2026-09-14', {
      priorities: [makePriority(1, 'Write the proposal')],
      sessions: [session(1, '2026-09-14', at('2026-09-14', 9), 600, { priorityUid: FIRST_UID })],
    });
    const tue = makeDay('2026-09-15', { priorities: [makePriority(1, 'write the proposal ', { done: true })] });
    const r = reviewRange([tue, mon], settings, '2026-09-16', now);
    // The tile still counts each day's rows; the list is what the range never finished.
    expect(r).toMatchObject({ prioritiesDone: 1, prioritiesTotal: 2, notDone: [] });
    // Left open again after the tick: only the days since, and only their time.
    const wed = makeDay('2026-09-16', { priorities: [makePriority(1, 'Write the proposal')] });
    expect(reviewRange([mon, tue, wed], settings, '2026-09-16', now).notDone).toEqual([
      { key: 'text:write the proposal', text: 'Write the proposal', dates: ['2026-09-16'], focusedSeconds: 0, addedMidDay: false },
    ]);
    // Ticked and left open on one day, in either order: the tick wins.
    for (const priorities of [
      [makePriority(1, 'Email', { done: true }), makePriority(2, 'email ')],
      [makePriority(1, 'email '), makePriority(2, 'Email', { done: true })],
    ]) {
      expect(reviewRange([makeDay('2026-09-14', { priorities })], settings, '2026-09-16', now).notDone).toEqual([]);
    }
  });

  it('is all zeros for no days', () => {
    expect(reviewRange([], settings, '2026-09-16', now)).toEqual({
      days: 0,
      workedSeconds: 0,
      focusedSeconds: 0,
      offPlanSeconds: 0,
      onPlanPercent: null,
      prioritiesDone: 0,
      prioritiesTotal: 0,
      retrosDone: 0,
      sessions: 0,
      targetSeconds: 0,
      breaks: { count: 0, seconds: 0 },
      midDay: { added: 0, done: 0 },
      typicalDay: null,
      unplanned: [],
      routines: [],
      notDone: [],
      notes: [],
    });
  });

  it('counts completed sessions, not a running or a cancelled one', () => {
    const day = makeDay('2026-09-16', {
      sessions: [
        session(1, '2026-09-16', at('2026-09-16', 9), 600),
        session(2, '2026-09-16', at('2026-09-16', 10), 300, { status: 'cancelled' }),
        makeSession({ id: 3, date: '2026-09-16', startedAt: at('2026-09-16', 16, 50) }),
      ],
    });
    expect(reviewRange([day], settings, '2026-09-16', now)).toMatchObject({ sessions: 1, focusedSeconds: 600 });
  });

  it("adds up the clocked-in days' own lengths as the target, and holds a week to the Work week", () => {
    // Clocked out an hour short of an 8 h day: the target is the day's length, not the time worked.
    const full = makeDay('2026-09-14', { punches: punchesAt(at('2026-09-14', 8), null, null, at('2026-09-14', 15)) });
    const half = makeDay('2026-09-15', { workMinutes: 270, punches: punchesAt(at('2026-09-15', 8), null, null, at('2026-09-15', 12, 30)) });
    // A plan with no clock-in had no work day.
    const unpunched = planned('2026-09-16', 1, 0);
    const r = reviewRange([full, half, unpunched], settings, '2026-09-16', now);
    expect(r).toMatchObject({ days: 3, workedSeconds: (420 + 270) * 60, targetSeconds: (480 + 270) * 60 });
    expect(periodTarget('month', r, settings.weekMinutes)).toBe(r.targetSeconds);
    expect(periodTarget('quarter', r, settings.weekMinutes)).toBe(r.targetSeconds);
    // A week is held to the Work week setting, half day or not, and 0 sets no target.
    expect(periodTarget('week', r, settings.weekMinutes)).toBe(40 * 3600);
    expect(periodTarget('week', r, 0)).toBe(0);
  });

  it('counts the breaks on days with something on them, a running one so far', () => {
    const mon = makeDay('2026-09-14', {
      sessions: [session(1, '2026-09-14', at('2026-09-14', 9), 1500)],
      // A full five minutes, and a ten cut short at four.
      breaks: [brk(1, '2026-09-14', at('2026-09-14', 9, 25), 5), brk(2, '2026-09-14', at('2026-09-14', 11), 10, at('2026-09-14', 11, 4))],
    });
    // A break with nothing else on its day: the day isn't counted, so neither is the break.
    const breakOnly = makeDay('2026-09-15', { breaks: [brk(3, '2026-09-15', at('2026-09-15', 9), 15)] });
    // Six minutes into a fifteen at 17:00.
    const today = makeDay('2026-09-16', {
      sessions: [session(4, '2026-09-16', at('2026-09-16', 16), 3000)],
      breaks: [brk(5, '2026-09-16', at('2026-09-16', 16, 54), 15)],
    });
    expect(reviewRange([today, breakOnly, mon], settings, '2026-09-16', now).breaks).toEqual({ count: 3, seconds: (5 + 4 + 6) * 60 });
  });

  it('counts the rows added mid-day and how many of those got ticked', () => {
    const mon = makeDay('2026-09-14', {
      priorities: [
        makePriority(1, 'Plan the week', BEFORE_WORK),
        makePriority(2, 'Fire drill', { addedAt: at('2026-09-14', 11), done: true }),
        makePriority(3, 'Call Sam back', { addedAt: at('2026-09-14', 12) }),
        // Emptied since: no longer one of the day's rows.
        makePriority(4, '', { addedAt: at('2026-09-14', 13) }),
      ],
      sessions: [session(1, '2026-09-14', at('2026-09-14', 9), 600)],
    });
    // With no session logged, a row written late is still the plan.
    const tue = makeDay('2026-09-15', { priorities: [makePriority(1, 'Late start', { addedAt: at('2026-09-15', 15) })] });
    const wed = makeDay('2026-09-16', {
      priorities: [makePriority(1, 'Reply to Kim', { addedAt: at('2026-09-16', 10), done: true })],
      sessions: [session(2, '2026-09-16', at('2026-09-16', 9), 600)],
    });
    expect(reviewRange([mon, tue, wed], settings, '2026-09-16', now).midDay).toEqual({ added: 3, done: 2 });
  });

  it("takes a typical day's plan from the medians of the planned days before today", () => {
    // Today is still going, so its nine rows are left out: with them, planned would be 3.
    const r = reviewRange([planned('2026-09-14', 1, 0), planned('2026-09-15', 3, 1), planned('2026-09-16', 9, 9)], settings, '2026-09-16', now);
    // An even count is halfway between the middle two, rounded half up: 2 planned, and 0.5 → 1 done.
    expect(r.typicalDay).toEqual({ planned: 2, done: 1 });
    // An odd count takes each list's middle on its own: 1 done, not the 5-row day's 0. A clocked-in
    // day with nothing written isn't a planned day: counted, planned would be 4.
    const clockedOnly = makeDay('2026-09-11', { punches: punchesAt(at('2026-09-11', 8)) });
    const odd = [planned('2026-09-08', 3, 1), planned('2026-09-09', 5, 0), planned('2026-09-10', 6, 2), clockedOnly];
    expect(reviewRange(odd, settings, '2026-09-16', now).typicalDay).toEqual({ planned: 5, done: 1 });
    // One planned day before today isn't a typical one.
    expect(reviewRange([planned('2026-09-15', 3, 2), planned('2026-09-16', 3, 3)], settings, '2026-09-16', now).typicalDay).toBeNull();
  });

  it('rounds the on-plan share to a whole percent, and has none without focus logged', () => {
    const third = makeDay('2026-09-14', {
      priorities: [makePriority(1, 'Ship it')],
      sessions: [session(1, '2026-09-14', at('2026-09-14', 9), 600, { priorityUid: FIRST_UID }), session(2, '2026-09-14', at('2026-09-14', 10), 1200)],
    });
    expect(reviewRange([third], settings, '2026-09-16', now).onPlanPercent).toBe(33);
    const twoThirds = { ...third, sessions: third.sessions.map((s) => ({ ...s, priorityUid: s.priorityUid ? null : FIRST_UID })) };
    expect(reviewRange([twoThirds], settings, '2026-09-16', now).onPlanPercent).toBe(67);
    // All of it off the plan is none on it, which is not the same as nothing logged.
    const offPlan = { ...third, sessions: third.sessions.map((s) => ({ ...s, priorityUid: null })) };
    expect(reviewRange([offPlan], settings, '2026-09-16', now).onPlanPercent).toBe(0);
    // A day with a plan and no sessions still counts as a day, with its rows open.
    const r = reviewRange([{ ...third, sessions: [] }], settings, '2026-09-16', now);
    expect(r).toMatchObject({ days: 1, focusedSeconds: 0, onPlanPercent: null });
    expect(r.notDone.map((g) => g.text)).toEqual(['Ship it']);
  });

  it('orders equally long unplanned work by date', () => {
    const later = makeDay('2026-09-15', { sessions: [session(3, '2026-09-15', at('2026-09-15', 9), 600)] });
    const earlier = makeDay('2026-09-14', { sessions: [session(1, '2026-09-14', at('2026-09-14', 9), 600)] });
    const r = reviewRange([later, earlier], settings, '2026-09-16', now);
    expect(r.unplanned.map((u) => [u.label, u.seconds])).toEqual([
      ['s1', 600],
      ['s3', 600],
    ]);
    expect(r.focusedSeconds).toBe(1200);
  });

  it('merges repeats by label or text, whatever the case and spacing', () => {
    const mon = makeDay('2026-09-14', {
      priorities: [makePriority(1, 'Review the PR', BEFORE_WORK), makePriority(2, 'Ship it', { done: true }), makePriority(3, 'Plan next sprint', BEFORE_WORK)],
      sessions: [
        session(1, '2026-09-14', at('2026-09-14', 9), 600, { label: 'Expense receipts' }),
        session(2, '2026-09-14', at('2026-09-14', 11), 300, { label: 'expense  receipts ' }),
        session(3, '2026-09-14', at('2026-09-14', 13), 1500, { label: '' }),
        session(4, '2026-09-14', at('2026-09-14', 14), 900, { priorityUid: FIRST_UID }),
      ],
    });
    const tue = makeDay('2026-09-15', {
      priorities: [makePriority(1, 'Call the bank', BEFORE_WORK), makePriority(2, 'review the PR ', { addedAt: at('2026-09-15', 12) })],
      sessions: [
        session(5, '2026-09-15', at('2026-09-15', 9), 600, { label: 'Expense Receipts' }),
        session(6, '2026-09-15', at('2026-09-15', 10), 1200, { priorityUid: SECOND_UID }),
      ],
    });
    const r = reviewRange([tue, mon], settings, '2026-09-16', now);
    expect(r.unplanned).toEqual([
      { key: 'expense receipts', label: 'Expense Receipts', seconds: 1500, dates: ['2026-09-14', '2026-09-15'] },
      { key: '', label: '', seconds: 1500, dates: ['2026-09-14'] },
    ]);
    // Left open on two days comes first, then by date; the latest spelling wins; mid-day on either day counts.
    expect(r.notDone).toEqual([
      { key: 'text:review the pr', text: 'review the PR', dates: ['2026-09-14', '2026-09-15'], focusedSeconds: 2100, addedMidDay: true },
      { key: 'text:plan next sprint', text: 'Plan next sprint', dates: ['2026-09-14'], focusedSeconds: 0, addedMidDay: false },
      { key: 'text:call the bank', text: 'Call the bank', dates: ['2026-09-15'], focusedSeconds: 0, addedMidDay: false },
    ]);
  });
});

// One-offs left open are grouped into tasks across days: by card, else by text.
describe('reviewRange: Not done', () => {
  const now = at('2026-09-18', 17);
  const MON = '2026-09-14';
  const TUE = '2026-09-15';
  const WED = '2026-09-16';
  const A = 'carda0000001';
  const B = 'cardb0000001';
  type Row = [text: string, cardUid?: string | null, done?: boolean];
  /** A day whose rows were all written before work: none reads as added mid-day. */
  const day = (date: string, ...rows: Row[]) =>
    makeDay(date, { priorities: rows.map(([text, cardUid = null, done = false], i) => makePriority(i + 1, text, { cardUid, done, ...BEFORE_WORK })) });
  const notDone = (...days: Day[]) => reviewRange(days, settings, '2026-09-18', now).notDone.map((g) => [g.key, g.text, g.dates]);

  it('settles a cardless row by a later tick of a carded row of its text, and the other way round', () => {
    expect(notDone(day(MON, ['Report']), day(TUE, ['report', A, true]))).toEqual([]);
    expect(notDone(day(MON, ['Report', A]), day(TUE, ['report', null, true]))).toEqual([]);
  });

  it("makes a cardless task the card's once a row of its text gets a card, and a cardless row joins the latest task of its text", () => {
    expect(notDone(day(MON, ['Report']), day(TUE, ['Report', A]))).toEqual([[`card:${A}`, 'Report', [MON, TUE]]]);
    expect(notDone(day(MON, ['Report', A]), day(TUE, ['report ']))).toEqual([[`card:${A}`, 'report', [MON, TUE]]]);
  });

  it('keeps a task where it sorted when a row of it gets its card partway through', () => {
    const days = [day(MON, ['Invoices'], ['Report'], ['Email']), day(TUE, ['Invoices'], ['Report', A], ['Email'])];
    expect(notDone(...days)).toEqual([
      ['text:invoices', 'Invoices', [MON, TUE]],
      [`card:${A}`, 'Report', [MON, TUE]],
      ['text:email', 'Email', [MON, TUE]],
    ]);
  });

  it("keeps a card's rows one task when it is renamed, under its latest text, and a tick of the card settles every day of it", () => {
    expect(notDone(day(MON, ['Report', A]), day(TUE, ['Write the report', A]))).toEqual([[`card:${A}`, 'Write the report', [MON, TUE]]]);
    expect(notDone(day(MON, ['Report', A]), day(TUE, ['Write the report', A]), day(WED, ['Send the report', A, true]))).toEqual([]);
  });

  it('keeps two cards with one title two tasks, and a tick of one leaves the other open', () => {
    expect(notDone(day(MON, ['Email', A], ['Email', B]))).toEqual([
      [`card:${A}`, 'Email', [MON]],
      [`card:${B}`, 'Email', [MON]],
    ]);
    expect(notDone(day(MON, ['Email', A], ['Email', B]), day(TUE, ['Email', A, true]))).toEqual([[`card:${B}`, 'Email', [MON]]]);
    // A tick with no card settles every task of its text.
    expect(notDone(day(MON, ['Email', A], ['Email', B]), day(TUE, ['email', null, true]))).toEqual([]);
    // A row with no card left open joins one of them: the one seen last.
    expect(notDone(day(MON, ['Email', A], ['Email', B]), day(TUE, ['email']), day(WED, ['Email', A]))).toEqual([
      [`card:${A}`, 'Email', [MON, WED]],
      [`card:${B}`, 'email', [MON, TUE]],
    ]);
  });

  it('lets a tick win over the same task left open on its day', () => {
    expect(notDone(day(MON, ['Report', A, true], ['report']))).toEqual([]);
    expect(notDone(day(MON, ['Report', null, true], ['report', A]))).toEqual([]);
    // A card ticked doesn't settle another card of its title left open beside it.
    expect(notDone(day(MON, ['Email', A, true], ['Email', B]))).toEqual([[`card:${B}`, 'Email', [MON]]]);
  });

  it('groups and settles rows that share a card the way the same rows with no card group by text', () => {
    const days = [
      day(MON, ['Report', A], ['Invoices', B], ['Email']),
      day(TUE, ['Report', A], ['Invoices', B, true]),
      day(WED, ['Report', A], ['Call the bank']),
    ];
    const stripped = days.map((d) => ({ ...d, priorities: d.priorities.map((p) => ({ ...p, cardUid: null })) }));
    const withoutKeys = (ds: Day[]) => reviewRange(ds, settings, '2026-09-18', now).notDone.map(({ key: _key, ...g }) => g);
    expect(withoutKeys(days)).toEqual(withoutKeys(stripped));
    expect(notDone(...days).map(([key]) => key)).toEqual([`card:${A}`, 'text:email', 'text:call the bank']);
  });
});

// A routine's rows (`recurringUid`) are one entry across days, counted day by day, never a task left open.
describe('reviewRange: Routines', () => {
  const now = at('2026-09-18', 17);
  const MON = '2026-09-14';
  const TUE = '2026-09-15';
  const WED = '2026-09-16';
  const QUEUE = 'rcur00000001';
  const FOLLOW = 'rcur00000002';
  type Row = [text: string, recurringUid?: string | null, done?: boolean];
  /** A day whose rows were all written before work, with a 25-minute session on the row at position `focusOn`. */
  const day = (date: string, rows: Row[], focusOn?: number) =>
    makeDay(date, {
      priorities: rows.map(([text, recurringUid = null, done = false], i) => makePriority(i + 1, text, { recurringUid, done, ...BEFORE_WORK })),
      sessions: focusOn == null ? [] : [session(1, date, at(date, 9), 25 * 60, { priorityUid: makePriority(focusOn, '').uid })],
    });
  const review = (days: Day[], titles?: ReadonlyMap<string, string>) => reviewRange(days, settings, '2026-09-18', now, titles);

  it('counts the days a routine was ticked of the days it was on the list, and keeps its misses out of Not done', () => {
    const r = review([
      day(MON, [['Monitor the queue', QUEUE]], 1),
      day(TUE, [['Monitor the queue', QUEUE, true]], 1),
      day(WED, [['Monitor the queue', QUEUE]]),
    ]);
    expect(r.routines).toEqual([{ recurringUid: QUEUE, title: 'Monitor the queue', dates: [MON, TUE, WED], done: 1, focusedSeconds: 50 * 60 }]);
    // Tuesday's tick doesn't settle Monday's miss, and neither miss is a task left open.
    expect(r.notDone).toEqual([]);
  });

  it('counts the routines as priorities in the tiles and the facts', () => {
    const mon = makeDay(MON, {
      priorities: [
        makePriority(1, 'Ship it', { done: true, ...BEFORE_WORK }),
        makePriority(2, 'Monitor the queue', { recurringUid: QUEUE, done: true, ...BEFORE_WORK }),
        makePriority(3, 'Follow-ups', { recurringUid: FOLLOW, addedAt: at(MON, 11) }),
      ],
      sessions: [session(1, MON, at(MON, 9), 600, { priorityUid: makePriority(2, '').uid })],
    });
    const r = review([
      mon,
      day(TUE, [
        ['Ship it', null, true],
        ['Monitor the queue', QUEUE],
      ]),
    ]);
    expect(r).toMatchObject({
      prioritiesDone: 3,
      prioritiesTotal: 5,
      onPlanPercent: 100,
      midDay: { added: 1, done: 0 },
      typicalDay: { planned: 3, done: 2 },
      notDone: [],
    });
    expect(r.routines.map((g) => [g.title, g.dates.length, g.done, g.focusedSeconds])).toEqual([
      ['Monitor the queue', 2, 1, 600],
      ['Follow-ups', 1, 0, 0],
    ]);
  });

  it('leaves a one-off of the same text in Not done, unsettled by the routine', () => {
    const r = review([day(MON, [['Monitor the queue']]), day(TUE, [['monitor the queue', QUEUE, true]])]);
    expect(r.notDone.map((g) => [g.key, g.dates])).toEqual([['text:monitor the queue', [MON]]]);
    expect(r.routines.map((g) => [g.recurringUid, g.dates, g.done])).toEqual([[QUEUE, [TUE], 1]]);
  });

  it("keeps a routine whose row was retyped one entry, under the item's title while it exists, else the latest text", () => {
    const days = [day(MON, [['Monitor the queue', QUEUE, true]]), day(TUE, [['Watch the queue', QUEUE]])];
    expect(review(days).routines.map((g) => [g.title, g.dates])).toEqual([['Watch the queue', [MON, TUE]]]);
    expect(review(days, new Map([[QUEUE, 'Check the queue']])).routines.map((g) => g.title)).toEqual(['Check the queue']);
    // Deleted since: the board names other items but not this one.
    expect(review(days, new Map([[FOLLOW, 'Follow-ups']])).routines.map((g) => g.title)).toEqual(['Watch the queue']);
  });

  it('leaves out a day whose routine row was emptied', () => {
    const r = review([day(MON, [['Monitor the queue', QUEUE, true]]), day(TUE, [['', QUEUE]])]);
    expect(r.routines.map((g) => [g.dates, g.done])).toEqual([[[MON], 1]]);
    expect(r.prioritiesTotal).toBe(1);
  });

  it('lists the routines on the most days first, then the most focus, then by title', () => {
    const days = [
      day(
        MON,
        [
          ['Tickets', 'rcur0000000a'],
          ['Monitor the queue', QUEUE],
          ['Follow-ups', FOLLOW],
          ['Inbox', 'rcur0000000b'],
        ],
        // The one focused, last of the one-day routines by title.
        2,
      ),
      day(TUE, [['Tickets', 'rcur0000000a']]),
    ];
    expect(review(days).routines.map((g) => g.title)).toEqual(['Tickets', 'Monitor the queue', 'Follow-ups', 'Inbox']);
    // Sorted by the item's title, not the row's.
    expect(review(days, new Map([['rcur0000000b', 'Alerts']])).routines.map((g) => g.title)).toEqual(['Tickets', 'Monitor the queue', 'Alerts', 'Follow-ups']);
  });
});
