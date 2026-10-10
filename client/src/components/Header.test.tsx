// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { AuthGate } from '../auth/AuthGate';
import { VIEWS, type Route } from '../hooks/useRoute';
import { SettingsProvider } from '../hooks/useSettings';
import { answered, DEFAULT_USER, makeAuth, makeSettings, pressKey, settle, ShortcutKeys } from '../test/hooks';
import { Header } from './Header';

vi.mock('../api');

async function renderHeader(view: Route['view'] = 'sheet', { auth = makeAuth({ mode: 'none', user: DEFAULT_USER }) } = {}) {
  const onNavigate = vi.fn();
  vi.mocked(api.getAuth).mockResolvedValue(auth);
  render(
    <AuthGate>
      <SettingsProvider>
        <ShortcutKeys />
        <Header view={view} onNavigate={onNavigate} onOpenSettings={vi.fn()} />
      </SettingsProvider>
    </AuthGate>,
  );
  await settle();
  return onNavigate;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(api.getSettings).mockResolvedValue(answered(makeSettings()));
});
afterEach(cleanup);

describe('Header', () => {
  // The null route follows the date over midnight. The clock's date key is yesterday's until its next
  // tick, so a tap in that second would pin the sheet to yesterday.
  it('sends the brand to the null route', async () => {
    const onNavigate = await renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Clockspan' }));
    expect(onNavigate).toHaveBeenCalledWith({ view: 'sheet', date: null });
  });

  // Keyed to the sheet instead, History would read as pressed on a third view and send its click to the sheet.
  it('presses History on History only, and goes there from every other view and back to the sheet from it', async () => {
    for (const view of VIEWS) {
      const onNavigate = await renderHeader(view);
      const button = screen.getByRole('button', { name: 'History' });
      expect(button.getAttribute('aria-pressed'), view).toBe(String(view === 'history'));
      fireEvent.click(button);
      expect(onNavigate, view).toHaveBeenCalledWith({ view: view === 'history' ? 'sheet' : 'history' });
      cleanup();
    }
  });

  it('presses Board on the board only, and goes there from every other view and back to the sheet from it', async () => {
    for (const view of VIEWS) {
      const onNavigate = await renderHeader(view);
      const button = screen.getByRole('button', { name: 'Board' });
      expect(button.getAttribute('aria-pressed'), view).toBe(String(view === 'board'));
      fireEvent.click(button);
      expect(onNavigate, view).toHaveBeenCalledWith({ view: view === 'board' ? 'sheet' : 'board' });
      cleanup();
    }
  });

  // The control the focus was on may go with the page, so the focus moves to the button, as a click leaves it.
  it('binds S to the brand, H to History and B to Board, each button naming its key and taking the focus', async () => {
    let onNavigate = await renderHeader('history');
    const button = (name: string) => screen.getByRole('button', { name });
    const keys = (name: string) => button(name).getAttribute('aria-keyshortcuts');
    expect([keys('Clockspan'), keys('History')]).toEqual(['S', 'H']);
    pressKey('h');
    expect(onNavigate).toHaveBeenLastCalledWith({ view: 'sheet' });
    pressKey('s');
    expect(onNavigate).toHaveBeenLastCalledWith({ view: 'sheet', date: null });
    expect(document.activeElement).toBe(button('Clockspan'));
    cleanup();
    onNavigate = await renderHeader('board');
    expect(keys('Board')).toBe('B');
    pressKey('b');
    expect(onNavigate).toHaveBeenLastCalledWith({ view: 'sheet' });
    expect(onNavigate).toHaveBeenCalledOnce();
    cleanup();
    onNavigate = await renderHeader('sheet');
    pressKey('h');
    expect(onNavigate).toHaveBeenLastCalledWith({ view: 'history' });
    expect(document.activeElement).toBe(button('History'));
    pressKey('b');
    expect(onNavigate).toHaveBeenLastCalledWith({ view: 'board' });
    expect(document.activeElement).toBe(button('Board'));
  });

  // Board, History, Settings and Sign out leave no room on a narrow phone for the brand's name;
  // every view keeps the same header, so a page switch moves nothing.
  it('marks the row crowded on every view with someone signed in; the brand keeps its name', async () => {
    const crowded = () => document.querySelector('.topbar-row--crowded') !== null;
    for (const view of VIEWS) {
      await renderHeader(view, { auth: makeAuth({ user: DEFAULT_USER }) });
      expect(crowded(), view).toBe(true);
      expect(screen.getByRole('button', { name: 'Clockspan' })).toBeTruthy();
      cleanup();
    }
    await renderHeader('sheet');
    expect(crowded()).toBe(false);
  });
});
