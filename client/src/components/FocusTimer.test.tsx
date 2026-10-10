// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { useDay } from '../hooks/useDay';
import { useTimer } from '../hooks/useTimer';
import { warnSaveFailed } from '../lib/alerts';
import { BREAK, SAVE_FAILED } from '../lib/copy';
import type { CategoryPick } from '../lib/board';
import {
  answered,
  AppProviders,
  deferred,
  deferredAnswer,
  endSession,
  makeBreak,
  makeCategory,
  makeDay,
  makePick,
  makePriority,
  makeSession,
  makeSettings,
  pressKey,
  settle,
  ShortcutKeys,
  T0,
  TODAY,
} from '../test/hooks';
import type { Break, Priority, SessionResponse } from '../types';
import { MINUTE_MS } from '../../../shared/dates.js';
import { MAX_PRIORITIES } from '../../../shared/settings.js';
import { FocusTimer } from './FocusTimer';

vi.mock('../api');
vi.mock('../lib/alerts');

/** The task uid a start made off the card (a board item's Start) waits for. */
let elsewhere = deferred<string | null>();

/**
 * The card as the sheet wires it: today's priorities from the store. Beside it, whether the timer
 * counts a start as out, which the board reads, and a start made off the card, as the board's is.
 */
function Card({ pick, isToday = true }: { pick: CategoryPick | null; isToday?: boolean }) {
  const { day } = useDay(TODAY);
  const { starting, start } = useTimer();
  if (!day) return null;
  return (
    <>
      <FocusTimer date={TODAY} isToday={isToday} priorities={day.priorities} pick={pick} />
      <output aria-label="A start is out">{String(starting)}</output>
      <button onClick={() => void start(TODAY, 25 * 60, 'Board task', elsewhere.promise)}>Start elsewhere</button>
    </>
  );
}

/** `n` priority rows, all ticked. */
const ticked = (n: number) => Array.from({ length: n }, (_, i) => makePriority(i + 1, `Row ${i + 1}`, { done: true }));

async function renderCard(priorities: Priority[] = [], breaks: Break[] = [], pick: CategoryPick | null = null, { isToday = true } = {}) {
  vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { priorities, breaks })));
  render(
    <AppProviders>
      <ShortcutKeys />
      <Card pick={pick} isToday={isToday} />
    </AppProviders>,
  );
  await settle();
}

const start25 = () => screen.getByRole('button', { name: /^25\s*min$/ });
const box = () => screen.getByRole<HTMLInputElement>('combobox', { name: 'Session label' });
const typeLabel = (text: string) => fireEvent.change(box(), { target: { value: text } });
/** The label box's suggestions, as their text reads: the row's number, then its name. */
const suggestions = () => screen.queryAllByRole('option').map((o) => o.textContent);
const started = (session = makeSession({ label: 'Call the vendor' })): SessionResponse => ({ session });
const disabled = (name: string | RegExp) => (screen.getByRole('button', { name }) as HTMLButtonElement).disabled;
const startOut = () => screen.getByRole('status', { name: 'A start is out' }).textContent;
/** A press with the keyboard: the focus is on the button as it acts. */
const press = (el: HTMLElement) => {
  act(() => el.focus());
  fireEvent.click(el);
};

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  elsewhere = deferred<string | null>();
  vi.mocked(api.getSettings).mockResolvedValue(answered(makeSettings()));
  vi.mocked(api.getRunning).mockResolvedValue(answered({ session: null }));
  vi.mocked(api.putPriorities).mockImplementation((_date, priorities) => Promise.resolve(answered({ priorities })));
});

describe('FocusTimer', () => {
  it('sends one start for a second tap while the first is out', async () => {
    const answer = deferredAnswer<SessionResponse>();
    vi.mocked(api.startSession).mockReturnValue(answer.promise);
    await renderCard();
    typeLabel('Write the report');
    expect(disabled(/^Break · /)).toBe(false);
    fireEvent.click(start25());
    // A break tap would race the start on another queue, so the Break button waits too.
    expect(disabled(/^Break · /)).toBe(true);
    fireEvent.click(start25());
    await settle();
    // Nor is the new name's row added twice.
    expect(api.putPriorities).toHaveBeenCalledTimes(1);
    const uid = vi.mocked(api.putPriorities).mock.lastCall![1][0]!.uid;
    expect(api.startSession).toHaveBeenCalledExactlyOnceWith(TODAY, 25 * 60, 'Write the report', uid);
    answer.resolve(started(makeSession({ label: 'Write the report' })));
    await settle();
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toBeTruthy();
  });

  it('holds the start buttons while a break start is out', async () => {
    const answer = deferredAnswer<{ break: Break }>();
    vi.mocked(api.startBreak).mockReturnValue(answer.promise);
    await renderCard();
    fireEvent.click(screen.getByRole('button', { name: /^Break · / }));
    // A start would race the break on another queue, so it waits for the break's answer.
    expect(disabled(/^25\s*min$/)).toBe(true);
    answer.resolve({ break: makeBreak({ startedAt: T0, endedAt: T0 + 5 * 60_000 }) });
    await settle();
    expect(disabled(/^25\s*min$/)).toBe(false);
    expect(screen.getByRole('button', { name: BREAK.end })).toBeTruthy();
  });

  it('starts a break on R as the Break button does, naming R on it, and holds the start buttons the same way', async () => {
    const answer = deferredAnswer<{ break: Break }>();
    vi.mocked(api.startBreak).mockReturnValue(answer.promise);
    await renderCard();
    const keys = () => screen.queryByRole('button', { name: /^Break · / })?.getAttribute('aria-keyshortcuts');
    expect(keys()).toBe('R');
    expect(pressKey('r')).toBe(false);
    expect(disabled(/^25\s*min$/)).toBe(true);
    // Held while its start is out, as the button is.
    expect(keys()).toBeNull();
    expect(pressKey('r')).toBe(true);
    answer.resolve({ break: makeBreak({ startedAt: T0, endedAt: T0 + 5 * 60_000 }) });
    await settle();
    expect(api.startBreak).toHaveBeenCalledOnce();
    // A break runs: the Break button has gone, and R with it.
    expect(keys()).toBeUndefined();
    expect(pressKey('r')).toBe(true);
  });

  it('leaves R alone while a start made off the card is out, as the Break button is held', async () => {
    vi.mocked(api.startSession).mockResolvedValue(answered(started(makeSession({ label: 'Board task' }))));
    await renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Start elsewhere' }));
    await settle();
    expect(disabled(/^Break · /)).toBe(true);
    expect(pressKey('r')).toBe(true);
    expect(api.startBreak).not.toHaveBeenCalled();
    elsewhere.resolve(null);
    await settle();
  });

  // A break is always today's, so R on a past day's card would start one there is no button for.
  it("leaves R alone on a past day's card, which shows no Break button", async () => {
    await renderCard([], [], null, { isToday: false });
    expect(screen.queryByRole('button', { name: /^Break · / })).toBeNull();
    expect(pressKey('r')).toBe(true);
    expect(api.startBreak).not.toHaveBeenCalled();
  });

  it('leaves R alone while a timer runs', async () => {
    vi.mocked(api.getRunning).mockResolvedValue(answered({ session: makeSession() }));
    await renderCard();
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toBeTruthy();
    expect(pressKey('r')).toBe(true);
    expect(api.startBreak).not.toHaveBeenCalled();
  });

  it('holds End break while a start is out', async () => {
    const answer = deferredAnswer<SessionResponse>();
    vi.mocked(api.startSession).mockReturnValue(answer.promise);
    // A break that started half a minute ago and runs five minutes.
    await renderCard([], [makeBreak({ startedAt: T0 - 30_000, endedAt: T0 + 270_000 })]);
    expect(disabled(BREAK.end)).toBe(false);
    fireEvent.click(start25());
    expect(disabled(BREAK.end)).toBe(true);
    answer.resolve(started());
    await settle();
    // The running timer takes the card's place, break and all.
    expect(screen.queryByRole('button', { name: BREAK.end })).toBeNull();
    expect(screen.getByRole('timer')).toBeTruthy();
  });

  it('holds the start and break buttons while a start made off the card is out', async () => {
    vi.mocked(api.startSession).mockResolvedValue(answered(started(makeSession({ label: 'Board task' }))));
    await renderCard([], [makeBreak({ startedAt: T0 - 30_000, endedAt: T0 + 270_000 })]);
    expect(disabled(/^25\s*min$/)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Start elsewhere' }));
    await settle();
    expect(disabled(/^25\s*min$/)).toBe(true);
    expect(disabled(BREAK.end)).toBe(true);
    elsewhere.resolve(null);
    await settle();
    expect(api.startSession).toHaveBeenCalledExactlyOnceWith(TODAY, 25 * 60, 'Board task', null);
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toBeTruthy();
  });

  it('starts on the suggestion picked from the label box', async () => {
    vi.mocked(api.startSession).mockResolvedValue(answered(started()));
    await renderCard([makePriority(1, 'Ship the fix', { uid: 'abcdef123456' })]);
    fireEvent.click(box());
    expect(suggestions()).toEqual(['1Ship the fix']);
    fireEvent.click(screen.getByRole('option', { name: /Ship the fix/ }));
    expect(box().value).toBe('Ship the fix');
    expect(suggestions()).toEqual([]);
    fireEvent.click(start25());
    await settle();
    expect(api.putPriorities).not.toHaveBeenCalled();
    expect(api.startSession).toHaveBeenCalledWith(TODAY, 25 * 60, 'Ship the fix', 'abcdef123456');
  });

  it('starts on the row picked of two that share a name', async () => {
    vi.mocked(api.startSession).mockResolvedValue(answered(started()));
    await renderCard([makePriority(1, 'Email', { uid: 'email0000001' }), makePriority(2, 'Email', { uid: 'email0000002' })]);
    fireEvent.click(box());
    fireEvent.click(screen.getByRole('option', { name: '2 Email' }));
    fireEvent.click(start25());
    await settle();
    expect(api.startSession).toHaveBeenCalledWith(TODAY, 25 * 60, 'Email', 'email0000002');
  });

  it("lists today's open rows, numbered, on a press, narrowed by what is typed", async () => {
    await renderCard([makePriority(1, 'Ship the fix'), makePriority(2, 'Email', { done: true }), makePriority(3, 'Fix the build')]);
    expect(box().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(box());
    // A ticked row isn't listed: a done task isn't something to start on.
    expect(suggestions()).toEqual(['1Ship the fix', '3Fix the build']);
    expect(box().getAttribute('aria-expanded')).toBe('true');
    expect(box().getAttribute('aria-controls')).toBe(screen.getByRole('listbox', { name: "Today's open priorities" }).id);
    typeLabel('  the FIX');
    expect(suggestions()).toEqual(['1Ship the fix']);
    typeLabel('Call the vendor');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(box().getAttribute('aria-expanded')).toBe('false');
    expect(box().getAttribute('aria-controls')).toBeNull();
    // Leaving the box closes the list.
    typeLabel('');
    expect(suggestions()).toHaveLength(2);
    fireEvent.blur(box());
    expect(suggestions()).toEqual([]);
  });

  it('opens the list as the box takes the focus by Tab, not as the window gives it back', async () => {
    await renderCard([makePriority(1, 'Ship the fix')]);
    act(() => start25().focus());
    act(() => box().focus());
    expect(suggestions()).toEqual(['1Ship the fix']);
    expect(box().getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(box(), { key: 'Escape' });
    // A focus from no other control: the window's, as it returns to the front.
    fireEvent.focus(box());
    expect(box().getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps the focus in the box on a press on the list, so the click picks the option pressed', async () => {
    await renderCard([makePriority(1, 'Ship the fix')]);
    press(box());
    // false: the press's default, which would take the focus from the box and close the list
    // before the click, was stopped.
    expect(fireEvent.mouseDown(document.querySelector('.timer-suggest')!)).toBe(false);
    expect(fireEvent.mouseDown(screen.getByRole('option'))).toBe(false);
    expect(document.activeElement).toBe(box());
    expect(suggestions()).toEqual(['1Ship the fix']);
  });

  it('moves through the suggestions with ↓ and ↑ and picks with Enter; Escape closes them', async () => {
    // Chrome's scrollIntoView answers a promise; the card must not hand it to React as a cleanup.
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView').mockReturnValue(Promise.resolve() as never);
    await renderCard([makePriority(1, 'Ship the fix'), makePriority(2, 'Report'), makePriority(3, 'Email', { uid: 'email0000001' })]);
    const key = (k: string) => fireEvent.keyDown(box(), { key: k });
    const active = () => {
      const id = box().getAttribute('aria-activedescendant');
      const selected = screen.queryAllByRole('option', { selected: true });
      expect(selected.map((o) => o.id)).toEqual(id ? [id] : []);
      return selected[0]?.textContent;
    };
    key('ArrowDown');
    expect(active()).toBe('1Ship the fix');
    key('ArrowUp');
    expect(active()).toBe('1Ship the fix');
    key('ArrowDown');
    key('ArrowDown');
    key('ArrowDown');
    expect(active()).toBe('3Email');
    key('Escape');
    expect(suggestions()).toEqual([]);
    expect(box().getAttribute('aria-activedescendant')).toBeNull();
    // Closed, Enter picks nothing; ↑ opens the list again on its first row, as ↓ does.
    key('Enter');
    expect(box().value).toBe('');
    key('ArrowUp');
    expect(active()).toBe('1Ship the fix');
    key('ArrowDown');
    key('ArrowDown');
    // An input method's Enter and Escape are its own: they pick nothing and leave the list open.
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(box(), { key: 'Escape', isComposing: true });
    expect(box().value).toBe('');
    expect(active()).toBe('3Email');
    key('Enter');
    expect(box().value).toBe('Email');
    expect(suggestions()).toEqual([]);
    // With nothing matching, ↓ shows nothing to move to.
    typeLabel('Call the vendor');
    key('ArrowDown');
    expect(active()).toBeUndefined();
    expect(scroll).toHaveBeenCalled();
  });

  it('drops the link to a picked row once the box is typed in', async () => {
    vi.mocked(api.startSession).mockResolvedValue(answered(started()));
    await renderCard([makePriority(1, 'Ship the fix', { uid: 'abcdef123456' })]);
    fireEvent.click(box());
    fireEvent.click(screen.getByRole('option', { name: /Ship the fix/ }));
    typeLabel('Ship the fix 2');
    fireEvent.click(start25());
    await settle();
    const rows = vi.mocked(api.putPriorities).mock.lastCall![1];
    expect(rows[1]).toMatchObject({ text: 'Ship the fix 2', done: false });
    expect(api.startSession).toHaveBeenCalledWith(TODAY, 25 * 60, 'Ship the fix 2', rows[1]!.uid);
  });

  it('starts an untitled session on no task from an empty box', async () => {
    vi.mocked(api.startSession).mockResolvedValue(answered(started()));
    await renderCard([makePriority(1, 'Ship the fix')]);
    fireEvent.click(start25());
    await settle();
    expect(api.putPriorities).not.toHaveBeenCalled();
    expect(api.startSession).toHaveBeenCalledWith(TODAY, 25 * 60, '', null);
  });

  it("names the running session by its row's current text, not the label it started with", async () => {
    vi.mocked(api.getRunning).mockResolvedValue(answered({ session: makeSession({ label: 'Started as this', priorityUid: 'abcdef123456' }) }));
    await renderCard([makePriority(1, 'Ship the fix', { uid: 'abcdef123456' })]);
    expect(screen.getByText('Ship the fix').className).toBe('timer-running-label');
    expect(screen.queryByText('Started as this')).toBeNull();
  });

  it('adds typed work to the plan and starts linked to the new row', async () => {
    vi.mocked(api.startSession).mockResolvedValue(answered(started()));
    await renderCard();
    typeLabel('Call the vendor');
    fireEvent.click(start25());
    await settle();
    const rows = vi.mocked(api.putPriorities).mock.lastCall![1];
    expect(rows[0]).toMatchObject({ text: 'Call the vendor', done: false });
    expect(api.startSession).toHaveBeenCalledWith(TODAY, 25 * 60, 'Call the vendor', rows[0]!.uid);
  });

  it('starts on the open row whose name was typed, adding none', async () => {
    vi.mocked(api.startSession).mockResolvedValue(answered(started()));
    await renderCard([makePriority(1, 'Ship the fix', { uid: 'abcdef123456' })]);
    typeLabel('  ship THE fix ');
    fireEvent.click(start25());
    await settle();
    expect(api.putPriorities).not.toHaveBeenCalled();
    expect(api.startSession).toHaveBeenCalledWith(TODAY, 25 * 60, 'ship THE fix', 'abcdef123456');
  });

  it("adds a new row under a ticked row's name, which stays ticked", async () => {
    vi.mocked(api.startSession).mockResolvedValue(answered(started()));
    await renderCard([makePriority(1, 'Email', { uid: 'abcdef123456', done: true })]);
    typeLabel('Email');
    fireEvent.click(start25());
    await settle();
    const rows = vi.mocked(api.putPriorities).mock.lastCall![1];
    expect(rows.slice(0, 2)).toMatchObject([
      { text: 'Email', uid: 'abcdef123456', done: true },
      { text: 'Email', done: false },
    ]);
    expect(api.startSession).toHaveBeenCalledWith(TODAY, 25 * 60, 'Email', rows[1]!.uid);
  });

  it('starts on no task on a full list', async () => {
    vi.mocked(api.startSession).mockResolvedValue(answered(started()));
    await renderCard(ticked(MAX_PRIORITIES), [], makePick([]));
    typeLabel('Call the vendor');
    expect(screen.queryByRole('button', { name: /^Category for the new priority:/ })).toBeNull();
    fireEvent.click(start25());
    await settle();
    expect(api.putPriorities).not.toHaveBeenCalled();
    expect(api.startSession).toHaveBeenCalledWith(TODAY, 25 * 60, 'Call the vendor', null);
  });

  it('adds typed work in the first free row, between written ones', async () => {
    vi.mocked(api.startSession).mockResolvedValue(answered(started()));
    await renderCard([makePriority(1, 'Report'), makePriority(3, 'Email')]);
    typeLabel('Call the vendor');
    fireEvent.click(start25());
    await settle();
    const rows = vi.mocked(api.putPriorities).mock.lastCall![1];
    expect(rows.map((p) => p.text)).toEqual(['Report', 'Call the vendor', 'Email']);
    expect(api.startSession).toHaveBeenCalledWith(TODAY, 25 * 60, 'Call the vendor', rows[1]!.uid);
  });

  it("counts the start as out from the tap while the new row's save is out, so the board holds its Start too", async () => {
    const saved = deferredAnswer<{ priorities: Priority[] }>();
    vi.mocked(api.putPriorities).mockReturnValueOnce(saved.promise);
    vi.mocked(api.startSession).mockResolvedValue(answered(started()));
    await renderCard();
    typeLabel('Call the vendor');
    expect(startOut()).toBe('false');
    fireEvent.click(start25());
    await settle();
    expect(startOut()).toBe('true');
    expect(api.startSession).not.toHaveBeenCalled();
    const rows = vi.mocked(api.putPriorities).mock.lastCall![1];
    saved.resolve({ priorities: rows });
    await settle();
    expect(api.startSession).toHaveBeenCalledExactlyOnceWith(TODAY, 25 * 60, 'Call the vendor', rows[0]!.uid);
    expect(startOut()).toBe('false');
  });

  describe("the new row's category", () => {
    const TICKETS = makeCategory('cat000000001', 'Tickets');
    const ADMIN = makeCategory('cat000000002', 'Admin', { color: 'teal' });
    const chip = () => screen.queryByRole('button', { name: /^Category for the new priority:/ });

    it('offers a chip while the typed name matches no open row, and adds the row in the category picked', async () => {
      vi.mocked(api.startSession).mockResolvedValue(answered(started()));
      await renderCard([makePriority(1, 'Ship the fix')], [], makePick([TICKETS, ADMIN]));
      expect(chip()).toBeNull();
      typeLabel('Call the vendor');
      expect(chip()!.getAttribute('aria-label')).toBe('Category for the new priority: none');
      fireEvent.click(chip()!);
      fireEvent.click(screen.getByRole('option', { name: 'Admin' }));
      expect(chip()!.getAttribute('aria-label')).toBe('Category for the new priority: Admin');
      // An open row's name, or an empty box, takes the chip away and sends nothing; a new name
      // again finds the pick still there.
      typeLabel('ship the fix');
      expect(chip()).toBeNull();
      typeLabel('');
      expect(chip()).toBeNull();
      typeLabel('Call the vendor');
      expect(chip()!.getAttribute('aria-label')).toBe('Category for the new priority: Admin');
      expect(api.putPriorities).not.toHaveBeenCalled();

      fireEvent.click(start25());
      await settle();
      const row = vi.mocked(api.putPriorities).mock.lastCall![1][1]!;
      expect(row).toMatchObject({ text: 'Call the vendor', categoryUid: ADMIN.uid });
      expect(api.startSession).toHaveBeenCalledWith(TODAY, 25 * 60, 'Call the vendor', row.uid);
    });

    it('starts the next session with no category, as the label starts empty', async () => {
      vi.mocked(api.startSession).mockResolvedValue(answered(started()));
      vi.mocked(api.finishSession).mockResolvedValue(answered({ session: endSession(makeSession({ label: 'Call the vendor' })) }));
      await renderCard([], [], makePick([TICKETS]));
      typeLabel('Call the vendor');
      fireEvent.click(chip()!);
      fireEvent.click(screen.getByRole('option', { name: 'Tickets' }));
      fireEvent.click(start25());
      await settle();
      fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
      await settle();
      expect(box().value).toBe('');
      typeLabel('Email the vendor');
      expect(chip()!.getAttribute('aria-label')).toBe('Category for the new priority: none');
    });

    it('starts the next session with no category after a start linked to an open row, which adds none', async () => {
      const row = makePriority(1, 'Ship the fix');
      vi.mocked(api.startSession).mockResolvedValue(answered(started(makeSession({ label: 'Ship the fix', priorityUid: row.uid }))));
      vi.mocked(api.finishSession).mockResolvedValue(answered({ session: endSession(makeSession({ label: 'Ship the fix', priorityUid: row.uid })) }));
      await renderCard([row], [], makePick([TICKETS]));
      typeLabel('Ship');
      fireEvent.click(chip()!);
      fireEvent.click(screen.getByRole('option', { name: 'Tickets' }));
      // A pick from the label box's list takes the chip away with the new name.
      fireEvent.click(screen.getByRole('option', { name: /Ship the fix/ }));
      expect(chip()).toBeNull();
      fireEvent.click(start25());
      await settle();
      expect(api.putPriorities).not.toHaveBeenCalled();
      expect(api.startSession).toHaveBeenCalledWith(TODAY, 25 * 60, 'Ship the fix', row.uid);
      fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
      await settle();
      typeLabel('Email the vendor');
      expect(chip()!.getAttribute('aria-label')).toBe('Category for the new priority: none');
    });

    it('offers no category again once the row is added, a failed start included', async () => {
      vi.mocked(api.startSession).mockRejectedValueOnce(new Error('The server did not answer in time.'));
      await renderCard([], [], makePick([TICKETS]));
      typeLabel('Call the vendor');
      fireEvent.click(chip()!);
      fireEvent.click(screen.getByRole('option', { name: 'Tickets' }));
      fireEvent.click(start25());
      await settle();
      expect(vi.mocked(api.putPriorities).mock.lastCall![1][0]).toMatchObject({ text: 'Call the vendor', categoryUid: TICKETS.uid });
      // The start failed after the row went on the list: its name is an open row's now, and a new
      // name starts with none.
      expect(chip()).toBeNull();
      typeLabel('Email the vendor');
      expect(chip()!.getAttribute('aria-label')).toBe('Category for the new priority: none');
    });
  });

  it('retries a failed start against the row it already added, not a second copy', async () => {
    vi.mocked(api.startSession).mockRejectedValueOnce(new Error('The server did not answer in time.')).mockResolvedValueOnce(answered(started()));
    await renderCard();
    typeLabel('Call the vendor');
    fireEvent.click(start25());
    await settle();
    expect(screen.getByText('The server did not answer in time.')).toBeTruthy();

    fireEvent.click(start25());
    await settle();
    expect(api.putPriorities).toHaveBeenCalledTimes(1);
    const uid = vi.mocked(api.putPriorities).mock.lastCall![1][0]!.uid;
    expect(vi.mocked(api.startSession).mock.calls.map((c) => c[3])).toEqual([uid, uid]);
  });

  it("leaves a new row's failed save to the banner, with nothing under the start buttons", async () => {
    vi.mocked(api.putPriorities).mockRejectedValueOnce(new Error('Request failed (502)'));
    await renderCard();
    typeLabel('Call the vendor');
    fireEvent.click(start25());
    await settle();
    expect(warnSaveFailed).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(SAVE_FAILED.title)).toBeNull();
    expect(api.startSession).not.toHaveBeenCalled();
  });

  describe('the focus, as the control pressed goes', () => {
    it("goes to the running card's Pause once a start from the card lands", async () => {
      vi.mocked(api.startSession).mockResolvedValue(answered(started()));
      await renderCard();
      press(start25());
      await settle();
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Pause' }));
    });

    it('is not handed on after a start that failed, to a timer started later elsewhere', async () => {
      vi.mocked(api.startSession)
        .mockRejectedValueOnce(new Error('The server did not answer in time.'))
        .mockResolvedValueOnce(answered(started(makeSession({ label: 'Board task' }))));
      await renderCard();
      press(start25());
      await settle();
      fireEvent.click(screen.getByRole('button', { name: 'Start elsewhere' }));
      elsewhere.resolve(null);
      await settle();
      expect(screen.getByRole('timer', { name: 'Time remaining' })).toBeTruthy();
      expect(document.activeElement).toBe(document.body);
    });

    it("goes to the label box once the running card's Finish ends the session, opening no list over the card", async () => {
      vi.mocked(api.getRunning).mockResolvedValueOnce(answered({ session: makeSession() }));
      vi.mocked(api.finishSession).mockResolvedValue(answered({ session: endSession(makeSession()) }));
      await renderCard([makePriority(1, 'Ship the fix')]);
      press(screen.getByRole('button', { name: 'Finish' }));
      await settle();
      expect(document.activeElement).toBe(box());
      expect(box().getAttribute('aria-expanded')).toBe('false');
      // A press still opens it.
      fireEvent.click(box());
      expect(suggestions()).toEqual(['1Ship the fix']);
    });

    it('goes from Break to End break and back, as each takes the place of the other', async () => {
      vi.mocked(api.startBreak).mockResolvedValue(answered({ break: makeBreak({ startedAt: T0, endedAt: T0 + 5 * MINUTE_MS }) }));
      vi.mocked(api.endBreak).mockResolvedValue(answered({ break: null }));
      await renderCard();
      press(screen.getByRole('button', { name: /^Break · / }));
      await settle();
      expect(document.activeElement).toBe(screen.getByRole('button', { name: BREAK.end }));
      press(screen.getByRole('button', { name: BREAK.end }));
      await settle();
      expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Break · / }));
    });

    // The end stamps `Date.now()`, which the card's one-second clock reaches only at its next tick.
    it('goes to Break when a break ended by hand leaves only at the next tick', async () => {
      const running = makeBreak({ startedAt: T0 - 3 * MINUTE_MS, endedAt: T0 + 2 * MINUTE_MS });
      vi.mocked(api.endBreak).mockResolvedValue(answered({ break: { ...running, endedAt: T0 + 400 } }));
      await renderCard([], [running]);
      vi.setSystemTime(T0 + 400);
      press(screen.getByRole('button', { name: BREAK.end }));
      await settle();
      expect(screen.getByRole('button', { name: BREAK.end })).toBeTruthy();
      await settle(1000);
      expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Break · / }));
    });
  });
});
