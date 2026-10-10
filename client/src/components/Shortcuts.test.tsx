// @vitest-environment happy-dom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { SettingsProvider } from '../hooks/useSettings';
import { answered, makeSettings, pressKey, settle } from '../test/hooks';
import { Shortcuts } from './Shortcuts';

vi.mock('../api');

async function renderShortcuts(settings = makeSettings()) {
  vi.mocked(api.getSettings).mockResolvedValue(answered(settings));
  render(
    <SettingsProvider>
      <Shortcuts />
    </SettingsProvider>,
  );
  await settle();
}

const dialog = () => screen.queryByRole('dialog', { name: 'Keyboard Shortcuts', hidden: true });
/** Each group's heading, then its keys and what they do. */
const groups = () =>
  [...dialog()!.querySelectorAll('section')].map((s) => [
    s.querySelector('h3')!.textContent,
    ...[...s.querySelectorAll('dt')].map((dt) => `${dt.textContent} ${dt.nextElementSibling!.textContent}`),
  ]);

beforeEach(() => {
  vi.useFakeTimers();
});

describe('Shortcuts', () => {
  it('opens the list on ?, focused and grouped, with the step the timer adds', async () => {
    await renderShortcuts(makeSettings({ adjustStepMinutes: 10 }));
    expect(dialog()).toBeNull();
    expect(pressKey('?', { shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(dialog());
    expect(groups()).toEqual([
      ['Add', 'N New priority on the sheet, new card in Later on the board'],
      ['Pages', "S Today's sheet", 'B Board, or back to the sheet', 'H History, or back to the sheet', '? This list'],
      ['Timer', 'P Pause or resume', "F Finish, once time's up", '+ Add 10 minutes', 'R Start a break from the timer card'],
    ]);
  });

  it('closes on Escape and on Close, and ? inside it does nothing', async () => {
    await renderShortcuts();
    pressKey('?');
    // The open dialog keeps the key from every shortcut: the browser has it.
    expect(pressKey('?')).toBe(true);
    fireEvent.keyDown(dialog()!, { key: 'Escape' });
    expect(dialog()).toBeNull();
    pressKey('?');
    fireEvent.click(within(dialog()!).getByRole('button', { name: 'Close shortcuts' }));
    expect(dialog()).toBeNull();
  });

  it('opens nothing with shortcuts off', async () => {
    await renderShortcuts(makeSettings({ shortcuts: false }));
    expect(pressKey('?')).toBe(true);
    expect(dialog()).toBeNull();
  });
});
