// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { dismissByTag, unlockAudio } from '../lib/alerts';
import { makeSettings, SettingsAndDays, settle } from '../test/hooks';
import { TimerLengths } from './TimerLengths';

vi.mock('../api');
vi.mock('../lib/alerts');

async function renderLengths(timerMinutes: number[], disabled = false) {
  vi.mocked(api.getSettings).mockResolvedValue(makeSettings({ timerMinutes }));
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

  it('unlocks the sound and takes the break banners down in the tap, before the start', async () => {
    const onStart = await renderLengths([25]);
    fireEvent.click(screen.getByRole('button', { name: /^25\s*min$/ }));
    expect(onStart).toHaveBeenCalledExactlyOnceWith(25);
    const started = onStart.mock.invocationCallOrder[0]!;
    expect(vi.mocked(unlockAudio).mock.invocationCallOrder[0]).toBeLessThan(started);
    expect(dismissByTag).toHaveBeenCalledExactlyOnceWith('break');
    expect(vi.mocked(dismissByTag).mock.invocationCallOrder[0]).toBeLessThan(started);
  });

  it('sends nothing while disabled', async () => {
    const onStart = await renderLengths([25], true);
    fireEvent.click(screen.getByRole('button', { name: /^25\s*min$/ }));
    expect(onStart).not.toHaveBeenCalled();
    expect(unlockAudio).not.toHaveBeenCalled();
  });
});
