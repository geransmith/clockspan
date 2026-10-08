// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { CONFIRM } from '../lib/copy';
import { useDay } from '../hooks/useDay';
import { useTimer } from '../hooks/useTimer';
import { MINUTE_MS } from '../../../shared/dates.js';
import type { CategoryPick } from '../lib/board';
import {
  AppProviders,
  breakAt,
  completedSession,
  deferred,
  endSession,
  type EndPatch,
  makeCategory,
  makeDay,
  makePick,
  makePriority,
  makeSession,
  makeSettings,
  settle,
  T0,
  TODAY,
} from '../test/hooks';
import type { Break, Priority, Session, SessionResponse } from '../types';
import { SessionLog } from './SessionLog';

vi.mock('../api');
vi.mock('../lib/alerts');

const PLANNED = [makePriority(1, 'Ship the fix', { uid: 'abcdef123456' })];
const DONE = endSession(makeSession(), { endedAt: T0 + 25 * MINUTE_MS, durationSeconds: 25 * 60 });
const RUNNING = makeSession({ id: 2, label: 'Still going', startedAt: T0 + 26 * MINUTE_MS });

/** The log on today's day store, wired as the sheet wires it, so an edit shows as the store lays it on. */
function LogOnStore({ pick }: { pick: CategoryPick }) {
  const { day } = useDay(TODAY);
  return day ? (
    <SessionLog date={TODAY} isToday sessions={day.sessions} breaks={day.breaks} priorities={day.priorities} pick={pick} now={T0 + 30 * MINUTE_MS} />
  ) : null;
}

/** The running timer's label, as the bar at the top shows it. */
function BarLabel() {
  return <output aria-label="Running bar">{useTimer().running?.label}</output>;
}

async function renderLog(
  sessions: Session[] = [DONE],
  breaks: Break[] = [],
  date = TODAY,
  { priorities = PLANNED, pick = null }: { priorities?: Priority[]; pick?: CategoryPick | null } = {},
) {
  render(
    <AppProviders>
      <BarLabel />
      <SessionLog date={date} isToday={date === TODAY} sessions={sessions} breaks={breaks} priorities={priorities} pick={pick} now={T0 + 30 * MINUTE_MS} />
    </AppProviders>,
  );
  await settle();
}

const openEdit = () => fireEvent.click(screen.getByRole('button', { name: /Write the report/ }));
const labelInput = () => screen.getByRole('textbox', { name: 'Session label' }) as HTMLInputElement;
const planSelect = () => screen.getByRole('combobox', { name: 'Priority this session was for' }) as HTMLSelectElement;
const bar = () => screen.getByRole('status', { name: 'Running bar' }).textContent;

beforeEach(() => {
  vi.useFakeTimers({ now: T0 + 30 * MINUTE_MS });
  vi.mocked(api.getSettings).mockResolvedValue(makeSettings());
  vi.mocked(api.getRunning).mockResolvedValue({ session: null });
  vi.mocked(api.getDay).mockResolvedValue(makeDay());
  vi.mocked(api.patchSession).mockImplementation((id, patch) => Promise.resolve({ session: { ...DONE, id, ...patch } }));
  vi.mocked(api.deleteSession).mockResolvedValue({ ok: true });
  vi.mocked(api.deleteBreak).mockResolvedValue({ ok: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('SessionLog', () => {
  it('sends a new label and a priority link together, in one PATCH', async () => {
    await renderLog();
    openEdit();
    fireEvent.change(labelInput(), { target: { value: 'Fix the login bug' } });
    fireEvent.change(planSelect(), { target: { value: 'abcdef123456' } });
    await settle();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Write the report/ }));
    expect(api.patchSession).toHaveBeenCalledTimes(1);
    expect(api.patchSession).toHaveBeenCalledWith(1, { priorityUid: 'abcdef123456', label: 'Fix the login bug' });
  });

  it('saves the label on Enter, and sends nothing for one left as it was', async () => {
    await renderLog();
    openEdit();
    fireEvent.keyDown(labelInput(), { key: 'Enter' });
    await settle();
    expect(api.patchSession).not.toHaveBeenCalled();

    openEdit();
    fireEvent.change(labelInput(), { target: { value: '  Renamed  ' } });
    fireEvent.keyDown(labelInput(), { key: 'Enter' });
    await settle();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Write the report/ }));
    expect(api.patchSession).toHaveBeenCalledWith(1, { label: 'Renamed' });
  });

  it('stays in the edit while an input method is composing, and saves on the Enter after it', async () => {
    await renderLog();
    openEdit();
    fireEvent.change(labelInput(), { target: { value: '会議' } });
    // The input method's own keys: Enter picks a candidate, Escape drops one.
    fireEvent.keyDown(labelInput(), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(labelInput(), { key: 'Escape', isComposing: true });
    await settle();
    expect(labelInput().value).toBe('会議');
    expect(api.patchSession).not.toHaveBeenCalled();
    fireEvent.keyDown(labelInput(), { key: 'Enter' });
    await settle();
    expect(screen.queryByRole('textbox', { name: 'Session label' })).toBeNull();
    expect(api.patchSession).toHaveBeenCalledExactlyOnceWith(1, { label: '会議' });
  });

  it('keeps the stored label on Escape', async () => {
    await renderLog();
    openEdit();
    fireEvent.change(labelInput(), { target: { value: 'Not this' } });
    fireEvent.keyDown(labelInput(), { key: 'Escape' });
    await settle();
    expect(screen.queryByRole('textbox', { name: 'Session label' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Write the report/ }));
    expect(api.patchSession).not.toHaveBeenCalled();
  });

  it('stays open while focus moves from the label to the select, and saves once it leaves both', async () => {
    await renderLog();
    openEdit();
    fireEvent.change(labelInput(), { target: { value: 'Relabeled' } });
    act(() => planSelect().focus());
    await settle();
    expect(labelInput()).toBeTruthy();
    expect(api.patchSession).not.toHaveBeenCalled();

    act(() => planSelect().blur());
    await settle();
    expect(screen.queryByRole('textbox', { name: 'Session label' })).toBeNull();
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: /Write the report/ }));
    expect(api.patchSession).toHaveBeenCalledWith(1, { label: 'Relabeled' });
  });

  it('edits the running row through the timer, so the bar shows the edit too', async () => {
    vi.mocked(api.getRunning).mockResolvedValue({ session: RUNNING });
    const answer = deferred<SessionResponse>();
    vi.mocked(api.patchSession).mockReturnValue(answer.promise);
    await renderLog([DONE, RUNNING]);
    expect(bar()).toBe('Still going');
    fireEvent.click(screen.getByRole('button', { name: /Still going/ }));
    fireEvent.change(labelInput(), { target: { value: 'Renamed' } });
    fireEvent.change(planSelect(), { target: { value: 'abcdef123456' } });
    await settle();
    expect(api.patchSession).toHaveBeenCalledTimes(1);
    expect(api.patchSession).toHaveBeenCalledWith(2, { priorityUid: 'abcdef123456', label: 'Renamed' });
    // Both at once, before the server answers.
    expect(bar()).toBe('Renamed');
    expect(screen.getByRole('button', { name: /Renamed/ }).textContent).toBe('1Renamed');
    expect(screen.getByRole('img', { name: 'Priority 1' }).textContent).toBe('1');
    answer.resolve({ session: { ...RUNNING, label: 'Renamed', priorityUid: 'abcdef123456' } });
    await settle();
    expect(bar()).toBe('Renamed');
  });

  describe("a session's category", () => {
    const TICKETS = makeCategory('cat000000001', 'Tickets');
    const ADMIN = makeCategory('cat000000002', 'Admin', { color: 'teal' });
    const PICK = makePick([TICKETS, ADMIN]);
    // The fix's row has a category; the emptied row still has one too.
    const ROWS = [
      makePriority(1, 'Ship the fix', { uid: 'abcdef123456', categoryUid: TICKETS.uid }),
      makePriority(2, '', { uid: 'emptied00000', categoryUid: ADMIN.uid }),
    ];
    const at = (id: number, label: string, patch: EndPatch = {}) => completedSession(id, T0 + id * MINUTE_MS, 60, { label, ...patch });
    const dot = (name: string) => screen.queryByRole('img', { name });
    const chip = () => screen.queryByRole('button', { name: /^Category for this session:/ });
    const edit = (label: RegExp) => fireEvent.click(screen.getByRole('button', { name: label }));

    it('shows a dot named for the category before the label of a session on no written row, and none for one on a row', async () => {
      await renderLog(
        [
          at(1, 'Picked', { categoryUid: ADMIN.uid }),
          at(2, 'On the emptied row', { priorityUid: 'emptied00000' }),
          at(3, 'On the fix', { priorityUid: 'abcdef123456', categoryUid: ADMIN.uid }),
          at(4, 'Unknown', { categoryUid: 'gone00000001' }),
          at(5, 'None'),
        ],
        [],
        TODAY,
        { priorities: ROWS, pick: PICK },
      );
      // Each label button's name, the dot's coming first: a planned row reads as its priority's
      // number instead, and an unknown category as nothing.
      for (const name of [/^Admin\s*Picked$/, /^Admin\s*On the emptied row$/, /^Priority 1\s*On the fix$/, /^Unknown$/, /^None$/]) {
        expect(screen.getByRole('button', { name })).toBeTruthy();
      }
      expect(screen.getByRole('button', { name: /Picked/ }).title).toBe('Edit label, priority or category');
    });

    it('shows the dot of a removed category, whose name the time keeps', async () => {
      const gone = makeCategory('cat000000003', 'Old project', { archived: true });
      await renderLog([at(1, 'Picked', { categoryUid: gone.uid })], [], TODAY, { priorities: ROWS, pick: makePick([TICKETS, gone]) });
      expect(dot('Old project')).toBeTruthy();
    });

    it('shows no dot and no chip with the board off', async () => {
      await renderLog([at(1, 'Picked', { categoryUid: ADMIN.uid })], [], TODAY, { priorities: ROWS });
      expect(dot('Admin')).toBeNull();
      edit(/Picked/);
      expect(chip()).toBeNull();
    });

    it('offers the chip in the edit of a session on no written row only, showing the category it counts under', async () => {
      await renderLog([at(1, 'On the emptied row', { priorityUid: 'emptied00000' }), at(2, 'On the fix', { priorityUid: 'abcdef123456' })], [], TODAY, {
        priorities: ROWS,
        pick: PICK,
      });
      edit(/On the emptied row/);
      expect(chip()!.getAttribute('aria-label')).toBe('Category for this session: Admin');
      fireEvent.keyDown(labelInput(), { key: 'Escape' });
      // The row's own chip on the sheet sets the category of a session on it.
      edit(/On the fix/);
      expect(chip()).toBeNull();
    });

    it('sends a pick with the label typed before it, in one PATCH, and puts the focus back on the label', async () => {
      await renderLog([at(1, 'Picked')], [], TODAY, { priorities: ROWS, pick: PICK });
      edit(/Picked/);
      fireEvent.change(labelInput(), { target: { value: 'Picked again' } });
      // A press on the chip leaves the focus in the box, so the edit stays open in Safari too.
      expect(fireEvent.mouseDown(chip()!)).toBe(false);
      fireEvent.click(chip()!);
      // The list is inside the edit box: the focus moving into it keeps the edit open.
      await settle();
      expect(labelInput()).toBeTruthy();
      expect(api.patchSession).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('option', { name: 'Tickets' }));
      await settle();
      expect(api.patchSession).toHaveBeenCalledExactlyOnceWith(1, { categoryUid: TICKETS.uid, label: 'Picked again' });
      expect(document.activeElement).toBe(screen.getByRole('button', { name: /Picked/ }));
    });

    it('clears the category of a session still on an emptied row with a category, by taking it off the row', async () => {
      const onEmptied = at(1, 'On the emptied row', { priorityUid: 'emptied00000' });
      vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { priorities: ROWS, sessions: [onEmptied] }));
      vi.mocked(api.patchSession).mockImplementation((_id, patch) => Promise.resolve({ session: { ...onEmptied, ...patch } }));
      render(
        <AppProviders>
          <LogOnStore pick={PICK} />
        </AppProviders>,
      );
      await settle();
      // No pick of its own: it counts under the emptied row's category.
      expect(dot('Admin')).toBeTruthy();
      edit(/On the emptied row/);
      fireEvent.click(chip()!);
      fireEvent.click(screen.getByRole('option', { name: 'Tickets' }));
      await settle();
      // A category of its own outranks the row's, so it stays on the row.
      expect(api.patchSession).toHaveBeenLastCalledWith(1, { categoryUid: TICKETS.uid });
      expect(dot('Tickets')).toBeTruthy();

      edit(/On the emptied row/);
      expect(chip()!.getAttribute('aria-label')).toBe('Category for this session: Tickets');
      fireEvent.click(chip()!);
      fireEvent.click(screen.getByRole('option', { name: 'No category' }));
      await settle();
      expect(api.patchSession).toHaveBeenLastCalledWith(1, { categoryUid: null, priorityUid: null });
      expect(api.patchSession).toHaveBeenCalledTimes(2);
      expect(dot('Tickets')).toBeNull();
      expect(dot('Admin')).toBeNull();
      edit(/On the emptied row/);
      expect(chip()!.getAttribute('aria-label')).toBe('Category for this session: none');
    });

    it('drops the category a session was given here when the select links it to a row, in the same PATCH', async () => {
      await renderLog([at(1, 'Picked', { categoryUid: ADMIN.uid })], [], TODAY, { priorities: ROWS, pick: PICK });
      edit(/Picked/);
      fireEvent.change(planSelect(), { target: { value: 'abcdef123456' } });
      await settle();
      expect(api.patchSession).toHaveBeenCalledExactlyOnceWith(1, { priorityUid: 'abcdef123456', categoryUid: null });
    });

    it("edits the running row's category through the timer", async () => {
      vi.mocked(api.getRunning).mockResolvedValue({ session: RUNNING });
      vi.mocked(api.patchSession).mockImplementation((id, patch) => Promise.resolve({ session: { ...RUNNING, id, ...patch } }));
      await renderLog([RUNNING], [], TODAY, { priorities: ROWS, pick: PICK });
      edit(/Still going/);
      fireEvent.click(chip()!);
      fireEvent.click(screen.getByRole('option', { name: 'Admin' }));
      await settle();
      expect(api.patchSession).toHaveBeenCalledExactlyOnceWith(2, { categoryUid: ADMIN.uid });
      expect(dot('Admin')).toBeTruthy();
    });
  });

  it('shows the running row as the timer has it', async () => {
    // Renamed in the bar: the day's copy hasn't heard yet.
    vi.mocked(api.getRunning).mockResolvedValue({ session: { ...RUNNING, label: 'Renamed in the bar', pausedAt: T0 + 29 * MINUTE_MS } });
    await renderLog([DONE, RUNNING]);
    const row = screen.getAllByRole('listitem')[1]!.textContent;
    expect(row).toMatch(/Renamed in the bar/);
    expect(row).toMatch(/paused/);
  });

  it('deletes a session only once the confirm says yes, and never a running one', async () => {
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal('confirm', confirm);
    await renderLog([DONE, RUNNING]);
    const [done, running] = screen.getAllByRole('button', { name: 'Delete session' }) as HTMLButtonElement[];
    expect(running!.disabled).toBe(true);
    fireEvent.click(done!);
    await settle();
    expect(confirm).toHaveBeenCalledWith(CONFIRM.deleteSession);
    expect(api.deleteSession).not.toHaveBeenCalled();
    fireEvent.click(done!);
    await settle();
    expect(api.deleteSession).toHaveBeenCalledWith(1);
  });

  it('lists breaks between the sessions they followed, with their own total', async () => {
    const later = endSession(makeSession({ id: 2, label: 'Second one', startedAt: T0 + 40 * MINUTE_MS }), {
      endedAt: T0 + 50 * MINUTE_MS,
      durationSeconds: 600,
    });
    // A break still running at `now` counts what it has so far.
    await renderLog([later, DONE], [breakAt(1, 25, 5), breakAt(2, 28, 5)]);
    const rows = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatch(/Write the report/);
    expect(rows[1]).toMatch(/Break.*5m/);
    expect(rows[2]).toMatch(/Break.*on break.*2m/);
    expect(rows[3]).toMatch(/Second one/);
    expect(screen.getByText('On breaks').parentElement!.textContent).toBe('On breaks7m· 2 breaks');
  });

  it('shows breaks alone, and no break total without any', async () => {
    await renderLog([], [breakAt(1, 0, 5)]);
    expect(screen.getByText('On breaks').parentElement!.textContent).toBe('On breaks5m· 1 break');
    cleanup();
    await renderLog();
    expect(screen.queryByText('On breaks')).toBeNull();
  });

  it('says why the log is empty, today and on a past day', async () => {
    await renderLog([]);
    expect(screen.getByText(/No focus sessions yet/)).toBeTruthy();
    cleanup();
    // A past day with nothing logged isn't waiting for anything.
    await renderLog([], [], '2026-09-25');
    expect(screen.getByText('No focus sessions or breaks on this day.')).toBeTruthy();
  });

  it('deletes a break once the confirm says yes, and never one still running', async () => {
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal('confirm', confirm);
    await renderLog([DONE], [breakAt(7, 25, 3), breakAt(8, 29, 5)]);
    const [over, running] = screen.getAllByRole('button', { name: 'Delete break' }) as HTMLButtonElement[];
    expect(running!.disabled).toBe(true);
    fireEvent.click(over!);
    await settle();
    expect(confirm).toHaveBeenCalledWith(CONFIRM.deleteBreak);
    expect(api.deleteBreak).not.toHaveBeenCalled();
    fireEvent.click(over!);
    await settle();
    expect(api.deleteBreak).toHaveBeenCalledWith(7);
  });
});
