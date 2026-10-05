// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { UNTITLED_SESSION } from '../lib/copy';
import { formatCountdown } from '../lib/format';
import { MINUTE_MS } from '../../../shared/dates.js';
import { AppProviders, makeDay, makeSession, makeSettings, settle, T0 } from '../test/hooks';
import type { Session } from '../types';
import { RunningTimerBar } from './RunningTimerBar';

vi.mock('../api');
vi.mock('../lib/alerts');

async function renderBar(session: Session) {
  vi.mocked(api.getRunning).mockResolvedValue({ session });
  render(
    <AppProviders>
      <RunningTimerBar />
    </AppProviders>,
  );
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 + 5 * MINUTE_MS });
  vi.mocked(api.getSettings).mockResolvedValue(makeSettings());
  vi.mocked(api.getDay).mockResolvedValue(makeDay());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
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
    const label = () => screen.getByTitle('Edit label');
    const input = () => screen.getByRole('textbox', { name: 'Session label' }) as HTMLInputElement;
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
      await settle();
      expect(api.patchSession).toHaveBeenCalledExactlyOnceWith(1, { label: 'Draft the summary' });
    });

    it('saves when focus leaves the field', async () => {
      await edit('Renamed');
      fireEvent.blur(input());
      await settle();
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(api.patchSession).toHaveBeenCalledExactlyOnceWith(1, { label: 'Renamed' });
    });

    it('throws the draft away on Escape', async () => {
      await edit('Not this', 'Escape');
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(label().textContent).toBe('Write the report');
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
});
