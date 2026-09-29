// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { formatCountdown } from '../lib/format';
import { AllProviders, makeDay, makeSession, makeSettings, MIN, settle, T0 } from '../test/hooks';
import type { Session } from '../types';
import { RunningTimerBar } from './RunningTimerBar';

vi.mock('../api');
vi.mock('../lib/alerts');

async function renderBar(session: Session) {
  vi.mocked(api.getRunning).mockResolvedValue({ session });
  render(
    <AllProviders>
      <RunningTimerBar />
    </AllProviders>,
  );
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 + 5 * MIN });
  vi.mocked(api.getSettings).mockResolvedValue(makeSettings());
  vi.mocked(api.getDay).mockResolvedValue(makeDay());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('RunningTimerBar', () => {
  it('names the countdown for what it counts: the time left, then the time over', async () => {
    await renderBar(makeSession());
    expect(screen.getByRole('timer', { name: 'Time remaining' }).textContent).toBe('20:00');
    cleanup();
    // Two minutes past a 25-minute plan.
    await renderBar(makeSession({ startedAt: T0 - 22 * MIN }));
    expect(screen.getByRole('timer', { name: 'Time over' }).textContent).toBe(formatCountdown(-120));
  });
});
