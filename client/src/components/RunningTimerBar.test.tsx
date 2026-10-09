// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { UNTITLED_SESSION } from '../lib/copy';
import { formatCountdown } from '../lib/format';
import { MINUTE_MS } from '../../../shared/dates.js';
import { useDay } from '../hooks/useDay';
import { useTimer } from '../hooks/useTimer';
import { AppProviders, makeDay, makePriority, makeSession, makeSettings, setVisibility, settle, T0, TODAY } from '../test/hooks';
import type { Session } from '../types';
import { RunningTimerBar } from './RunningTimerBar';

vi.mock('../api');
vi.mock('../lib/alerts');

/**
 * Today's day held in the store, as the app always holds it (the sheet, the alarms), and a press
 * that reads it again, as the refresh loop does: how another device's rename reaches this one.
 */
function HoldToday() {
  const { store } = useDay(TODAY);
  return <button onClick={() => void store.refresh(TODAY)}>Read today again</button>;
}

/** Renders the bar as App does: while a session runs, keyed by it. */
function Bar() {
  const { running } = useTimer();
  return running ? <RunningTimerBar key={running.id} session={running} /> : null;
}

async function renderBar(session: Session) {
  vi.mocked(api.getRunning).mockResolvedValue({ session });
  render(
    <AppProviders>
      <HoldToday />
      <Bar />
    </AppProviders>,
  );
  await settle();
}

const label = () => screen.getByTitle('Edit label');
const input = () => screen.getByRole('textbox', { name: 'Session label' }) as HTMLInputElement;

beforeEach(() => {
  vi.useFakeTimers({ now: T0 + 5 * MINUTE_MS });
  vi.mocked(api.getSettings).mockResolvedValue(makeSettings());
  vi.mocked(api.getDay).mockResolvedValue(makeDay());
});

describe('RunningTimerBar', () => {
  it('names the countdown for what it counts: the time left, then the time over', async () => {
    await renderBar(makeSession());
    expect(screen.getByRole('timer', { name: 'Time remaining' }).textContent).toBe('20:00');
    cleanup();
    // Two minutes past a 25-minute plan.
    await renderBar(makeSession({ startedAt: T0 - 22 * MINUTE_MS }));
    expect(screen.getByRole('timer', { name: 'Time over' }).textContent).toBe(formatCountdown(-120));
  });

  describe('the label', () => {
    const session = makeSession();
    const edit = async (text: string, key?: 'Enter' | 'Escape') => {
      await renderBar(session);
      fireEvent.click(label());
      expect(document.activeElement).toBe(input());
      fireEvent.change(input(), { target: { value: text } });
      if (key) fireEvent.keyDown(input(), { key });
      await settle();
    };

    beforeEach(() => {
      vi.mocked(api.patchSession).mockImplementation((id, patch) => Promise.resolve({ session: { ...session, id, ...patch } }));
    });

    it('opens on the current label and saves the new one on Enter, trimmed, once', async () => {
      await renderBar(session);
      fireEvent.click(label());
      expect(input().value).toBe('Write the report');
      fireEvent.change(input(), { target: { value: '  Draft the summary ' } });
      fireEvent.keyDown(input(), { key: 'Enter' });
      // Shown at once, before the server answers.
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(label().textContent).toBe('Draft the summary');
      expect(document.activeElement).toBe(label());
      await settle();
      expect(api.patchSession).toHaveBeenCalledExactlyOnceWith(1, { label: 'Draft the summary' });
    });

    it('saves when focus leaves the field', async () => {
      await edit('Renamed');
      fireEvent.blur(input());
      await settle();
      expect(screen.queryByRole('textbox')).toBeNull();
      // A blur leaves focus wherever it went.
      expect(document.activeElement).not.toBe(label());
      expect(api.patchSession).toHaveBeenCalledExactlyOnceWith(1, { label: 'Renamed' });
    });

    it('throws the draft away on Escape', async () => {
      await edit('Not this', 'Escape');
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(label().textContent).toBe('Write the report');
      expect(document.activeElement).toBe(label());
      expect(api.patchSession).not.toHaveBeenCalled();
    });

    it('sends nothing for a label left as it was, spaces aside', async () => {
      await edit(' Write the report  ', 'Enter');
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(api.patchSession).not.toHaveBeenCalled();
    });

    it('stays open while an input method is composing, and saves on the Enter after it', async () => {
      await edit('会議');
      // The input method's own keys: Enter picks a candidate, Escape drops one.
      fireEvent.keyDown(input(), { key: 'Enter', isComposing: true });
      fireEvent.keyDown(input(), { key: 'Escape', isComposing: true });
      await settle();
      expect(input().value).toBe('会議');
      expect(api.patchSession).not.toHaveBeenCalled();
      fireEvent.keyDown(input(), { key: 'Enter' });
      await settle();
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(api.patchSession).toHaveBeenCalledExactlyOnceWith(1, { label: '会議' });
    });

    it('saves a cleared label, which reads as untitled', async () => {
      await edit('   ', 'Enter');
      expect(api.patchSession).toHaveBeenCalledExactlyOnceWith(1, { label: '' });
      expect(label().textContent).toBe(UNTITLED_SESSION);
    });
  });

  describe('a session with a task', () => {
    const session = makeSession({ priorityUid: 'u1' });
    const today = (text: string) => makeDay(TODAY, { priorities: [makePriority(1, text, { uid: 'u1' })] });
    const readToday = async (text: string) => {
      vi.mocked(api.getDay).mockResolvedValue(today(text));
      fireEvent.click(screen.getByRole('button', { name: 'Read today again' }));
      await settle();
    };

    beforeEach(() => {
      vi.mocked(api.getDay).mockResolvedValue(today('Ship the fix'));
      vi.mocked(api.patchSession).mockImplementation((id, patch) => Promise.resolve({ session: { ...session, id, ...patch } }));
    });

    it("shows the row's current text as plain text, with no label to edit", async () => {
      await renderBar(session);
      expect(screen.getByText('Ship the fix').tagName).toBe('SPAN');
      expect(screen.queryByTitle('Edit label')).toBeNull();
      expect(screen.queryByRole('button', { name: /Ship the fix/ })).toBeNull();
      // Renamed on another device.
      await readToday('Ship the hotfix');
      expect(screen.getByText('Ship the hotfix').className).toBe('running-label');
    });

    it('closes a label box open as another device links the session, sending nothing', async () => {
      await renderBar(makeSession());
      fireEvent.click(label());
      fireEvent.change(input(), { target: { value: 'Typed meanwhile' } });
      // The timer's sync as the tab comes back finds it linked to the row.
      vi.mocked(api.getRunning).mockResolvedValue({ session: { ...session, title: 'Ship the fix' } });
      await settle(6000);
      setVisibility('visible');
      await settle();
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(screen.getByText('Ship the fix').className).toBe('running-label');
      expect(api.patchSession).not.toHaveBeenCalled();
    });

    it("names a session whose task left the day by the task's name, with no label to edit", async () => {
      await renderBar(makeSession({ priorityUid: 'gone00000001', title: 'Left the day' }));
      expect(screen.getByText('Left the day').className).toBe('running-label');
      expect(screen.queryByTitle('Edit label')).toBeNull();
    });
  });
});
