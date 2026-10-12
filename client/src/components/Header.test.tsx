// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { AuthGate } from '../auth/AuthGate';
import { VIEWS, type Route } from '../hooks/useRoute';
import { SettingsProvider } from '../hooks/useSettings';
import { CONFIRM } from '../lib/copy';
import type { AuthInfo } from '../types';
import { answered, DEFAULT_USER, makeAuth, makeSettings, pressKey, settle, ShortcutKeys } from '../test/hooks';
import { Header } from './Header';

vi.mock('../api');

type LaterProps = Pick<ComponentProps<typeof Header>, 'laterOpen' | 'laterShut' | 'onOpenLater' | 'onCloseLater'>;

async function renderHeader(
  view: Route['view'] = 'sheet',
  { auth = makeAuth({ mode: 'none', user: DEFAULT_USER }), later = {} }: { auth?: AuthInfo; later?: Partial<LaterProps> } = {},
) {
  const onNavigate = vi.fn();
  vi.mocked(api.getAuth).mockResolvedValue(auth);
  render(
    <AuthGate>
      <SettingsProvider>
        <ShortcutKeys />
        <Header
          view={view}
          onNavigate={onNavigate}
          onOpenSettings={vi.fn()}
          laterOpen={false}
          laterShut={false}
          onOpenLater={vi.fn()}
          onCloseLater={vi.fn()}
          {...later}
        />
      </SettingsProvider>
    </AuthGate>,
  );
  await settle();
  return onNavigate;
}

beforeEach(() => {
  vi.useFakeTimers();
});

const later = () => screen.getByRole('button', { name: 'Add to Later' });

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

  // The words are hidden on a phone, so the aria-label keeps the key out of Board's, History's and Add to Later's names.
  it("names each button's key in its title while the keys are on, and keeps the names fixed", async () => {
    await renderHeader();
    const titles = () => screen.getAllByRole('button').map((b) => b.title);
    expect(titles()).toEqual(['Go to today (S)', 'Board (B)', 'History (H)', 'Add to Later (L)', 'Settings']);
    expect(['Board', 'History', 'Add to Later'].map((name) => screen.getByRole('button', { name }).getAttribute('aria-label'))).toEqual([
      'Board',
      'History',
      'Add to Later',
    ]);
    cleanup();
    vi.mocked(api.getSettings).mockResolvedValue(answered(makeSettings({ shortcuts: false })));
    await renderHeader();
    expect(titles()).toEqual(['Go to today', 'Board', 'History', 'Add to Later', 'Settings']);
  });

  it('opens the Later strip off the Board from Add to Later and L, saying whether it is open', async () => {
    for (const view of ['sheet', 'history'] as const) {
      const onOpenLater = vi.fn();
      await renderHeader(view, { later: { onOpenLater } });
      const button = later();
      expect([button.getAttribute('aria-expanded'), button.hasAttribute('aria-controls'), button.getAttribute('aria-keyshortcuts')], view).toEqual([
        'false',
        false,
        'L',
      ]);
      fireEvent.click(button);
      expect(pressKey('l'), view).toBe(false);
      expect(onOpenLater, view).toHaveBeenCalledTimes(2);
      cleanup();
    }
  });

  // L only puts the focus in an open strip's box, which keeps its text; the button closes it, and its
  // mousedown keeps an empty box from closing the strip through its blur before the click reopens it.
  it('closes an open strip from Add to Later, keeping the focus on it, while L goes on opening it', async () => {
    const onOpenLater = vi.fn();
    const onCloseLater = vi.fn();
    await renderHeader('sheet', { later: { laterOpen: true, onOpenLater, onCloseLater } });
    const button = later();
    expect([button.getAttribute('aria-expanded'), button.getAttribute('aria-controls')]).toEqual(['true', 'later-strip']);
    expect(fireEvent.mouseDown(button)).toBe(false);
    const focus = vi.spyOn(button, 'focus');
    fireEvent.click(button);
    expect(onCloseLater).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(document.activeElement).toBe(button);
    pressKey('l');
    expect(onOpenLater).toHaveBeenCalledOnce();
    expect(onCloseLater).toHaveBeenCalledOnce();
  });

  // Before the board's first read, or at the cap: no card can go in Later. An open strip says why
  // itself, and its button still closes it.
  it('shuts Add to Later while no card can go in Later, but not while its strip is open', async () => {
    const onOpenLater = vi.fn();
    const onCloseLater = vi.fn();
    await renderHeader('sheet', { later: { laterShut: true, onOpenLater } });
    expect([later().getAttribute('aria-disabled'), later().title, later().hasAttribute('aria-keyshortcuts')]).toEqual(['true', 'Add to Later', false]);
    fireEvent.click(later());
    expect(pressKey('l')).toBe(true);
    expect(onOpenLater).not.toHaveBeenCalled();
    cleanup();
    await renderHeader('sheet', { later: { laterShut: true, laterOpen: true, onCloseLater } });
    expect([later().hasAttribute('aria-disabled'), later().title]).toEqual([false, 'Add to Later (L)']);
    fireEvent.click(later());
    expect(onCloseLater).toHaveBeenCalledOnce();
  });

  // The strip never shows on the Board, where the button and L open Later's own box.
  it("presses Later's + on the Board, with no strip to expand", async () => {
    const plus = document.body.appendChild(document.createElement('button'));
    plus.id = 'board-add-later-button';
    const pressed = vi.fn();
    plus.addEventListener('click', pressed);
    const onOpenLater = vi.fn();
    await renderHeader('board', { later: { laterOpen: true, onOpenLater } });
    expect(later().hasAttribute('aria-expanded')).toBe(false);
    expect(later().hasAttribute('aria-controls')).toBe(false);
    fireEvent.click(later());
    pressKey('l');
    expect(pressed).toHaveBeenCalledTimes(2);
    expect(onOpenLater).not.toHaveBeenCalled();
    cleanup();
    await renderHeader('board', { later: { laterShut: true, laterOpen: true } });
    expect(later().getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(later());
    expect(pressed).toHaveBeenCalledTimes(2);
    plus.remove();
  });

  it('sends no sign-out when the confirm is answered no', async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    await renderHeader('sheet', { auth: makeAuth({ user: DEFAULT_USER }) });
    fireEvent.click(screen.getByRole('button', { name: /Sign Out/ }));
    await settle();
    expect(confirm).toHaveBeenCalledWith(CONFIRM.signOut);
    expect(api.logout).not.toHaveBeenCalled();
  });

  // The brand's name and the buttons' words hide by width alone (styles.css), so a page switch or
  // signing in moves nothing but the user's button.
  it('keeps one row on every view in every auth mode; the brand keeps its name', async () => {
    for (const auth of [makeAuth({ user: DEFAULT_USER }), makeAuth({ mode: 'none', user: DEFAULT_USER })])
      for (const view of VIEWS) {
        await renderHeader(view, { auth });
        expect(document.querySelector('.topbar > div')!.className, view).toBe('topbar-row');
        expect(screen.getByRole('button', { name: 'Clockspan' })).toBeTruthy();
        cleanup();
      }
  });
});
