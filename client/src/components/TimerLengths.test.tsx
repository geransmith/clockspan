// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { dismissByTag, offerNotifications, unlockAudio } from '../lib/alerts';
import { answered, deferredAnswer, makeSettings, SettingsAndDays, settle } from '../test/hooks';
import type { Settings } from '../types';
import { TimerLengths } from './TimerLengths';

vi.mock('../api');
vi.mock('../lib/alerts');

async function renderLengths(timerMinutes: number[], disabled = false) {
  vi.mocked(api.getSettings).mockResolvedValue(answered(makeSettings({ timerMinutes })));
  const onStart = vi.fn();
  render(
    <SettingsAndDays>
      <TimerLengths onStart={onStart} disabled={disabled} />
    </SettingsAndDays>,
  );
  await settle();
  return onStart;
}

const lengths = () => screen.getAllByRole('button').map((b) => b.textContent);

beforeEach(() => {
  vi.useFakeTimers();
});

describe('TimerLengths', () => {
  it('shows each length once, shortest first', async () => {
    await renderLengths([50, 25, 25]);
    expect(lengths()).toEqual(['25min', '50min']);
  });

  it("unlocks the sound, asks for notifications and takes the break banners, the break alarm's and the timer's endings down in the tap, before the start", async () => {
    const onStart = await renderLengths([25]);
    fireEvent.click(screen.getByRole('button', { name: /^25\s*min$/ }));
    expect(onStart).toHaveBeenCalledExactlyOnceWith(25);
    const started = onStart.mock.invocationCallOrder[0]!;
    const unlocked = vi.mocked(unlockAudio).mock.invocationCallOrder[0]!;
    expect(unlocked).toBeLessThan(started);
    expect(offerNotifications).toHaveBeenCalledExactlyOnceWith(true);
    expect(vi.mocked(offerNotifications).mock.invocationCallOrder[0]).toBeGreaterThan(unlocked);
    expect(vi.mocked(offerNotifications).mock.invocationCallOrder[0]).toBeLessThan(started);
    expect(vi.mocked(dismissByTag).mock.calls).toEqual([['break'], ['alarm:noBreak'], ['timer-complete']]);
    for (const order of vi.mocked(dismissByTag).mock.invocationCallOrder) expect(order).toBeLessThan(started);
  });

  it('sends nothing while disabled', async () => {
    const onStart = await renderLengths([25], true);
    fireEvent.click(screen.getByRole('button', { name: /^25\s*min$/ }));
    expect(onStart).not.toHaveBeenCalled();
    expect(unlockAudio).not.toHaveBeenCalled();
    expect(offerNotifications).not.toHaveBeenCalled();
  });

  it('asks for no notifications before the settings have loaded, since the switch may be off', async () => {
    const onStart = vi.fn();
    vi.mocked(api.getSettings).mockReturnValue(deferredAnswer<Settings>().promise);
    render(
      <SettingsAndDays>
        <TimerLengths onStart={onStart} disabled={false} />
      </SettingsAndDays>,
    );
    await settle();
    fireEvent.click(screen.getAllByRole('button')[0]!);
    expect(offerNotifications).toHaveBeenCalledExactlyOnceWith(false);
    expect(onStart).toHaveBeenCalledOnce();
  });
});
