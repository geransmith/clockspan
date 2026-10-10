// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays } from '../../../shared/dates.js';
import * as api from '../api';
import { AuthGate } from '../auth/AuthGate';
import { VIEWS, type Route } from '../hooks/useRoute';
import { SettingsProvider } from '../hooks/useSettings';
import { answered, DEFAULT_USER, deferredAnswer, makeAuth, makeSettings, pressKey, settle, ShortcutKeys, TODAY, YESTERDAY } from '../test/hooks';
import type { Settings } from '../types';
import { Header } from './Header';

vi.mock('../api');

async function renderHeader(
  date: string,
  view: Route['view'] = 'sheet',
  { auth = makeAuth({ mode: 'none', user: DEFAULT_USER }), customize = false, onToggleCustomize = vi.fn() } = {},
) {
  const onNavigate = vi.fn();
  vi.mocked(api.getAuth).mockResolvedValue(auth);
  render(
    <AuthGate>
      <SettingsProvider>
        <ShortcutKeys />
        <Header
          view={view}
          date={date}
          today={TODAY}
          customize={customize}
          onNavigate={onNavigate}
          onToggleCustomize={onToggleCustomize}
          onOpenSettings={vi.fn()}
        />
      </SettingsProvider>
    </AuthGate>,
  );
  await settle();
  return onNavigate;
}

/** happy-dom has no `showPicker`, so each test says what the browser has. */
function setShowPicker(value: (() => void) | undefined) {
  Object.defineProperty(HTMLInputElement.prototype, 'showPicker', { configurable: true, value });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(api.getSettings).mockResolvedValue(answered(makeSettings()));
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLInputElement.prototype, 'showPicker');
});

describe('Header', () => {
  // The null route follows the date over midnight. The clock's date key is yesterday's until its next
  // tick, so a tap in that second would pin the sheet to yesterday.
  it('sends the brand to the null route', async () => {
    const onNavigate = await renderHeader(TODAY);
    fireEvent.click(screen.getByRole('button', { name: 'Clockspan' }));
    expect(onNavigate).toHaveBeenCalledWith({ view: 'sheet', date: null });
  });

  // Keyed to the sheet instead, History would read as pressed on a third view and send its click to the sheet.
  it('presses History on History only, and goes there from every other view and back to the sheet from it', async () => {
    for (const view of VIEWS) {
      const onNavigate = await renderHeader(TODAY, view);
      const button = screen.getByRole('button', { name: 'History' });
      expect(button.getAttribute('aria-pressed'), view).toBe(String(view === 'history'));
      fireEvent.click(button);
      expect(onNavigate, view).toHaveBeenCalledWith({ view: view === 'history' ? 'sheet' : 'history' });
      cleanup();
    }
  });

  it('presses Board on the board only, and goes there from every other view and back to the sheet from it', async () => {
    for (const view of VIEWS) {
      const onNavigate = await renderHeader(TODAY, view);
      const button = screen.getByRole('button', { name: 'Board' });
      expect(button.getAttribute('aria-pressed'), view).toBe(String(view === 'board'));
      fireEvent.click(button);
      expect(onNavigate, view).toHaveBeenCalledWith({ view: view === 'board' ? 'sheet' : 'board' });
      cleanup();
    }
  });

  // The control the focus was on may go with the page, so the focus moves to the button, as a click leaves it.
  it('binds S to the brand, H to History and B to Board, each button naming its key and taking the focus', async () => {
    let onNavigate = await renderHeader(YESTERDAY, 'history');
    const button = (name: string) => screen.getByRole('button', { name });
    const keys = (name: string) => button(name).getAttribute('aria-keyshortcuts');
    expect([keys('Clockspan'), keys('History')]).toEqual(['S', 'H']);
    pressKey('h');
    expect(onNavigate).toHaveBeenLastCalledWith({ view: 'sheet' });
    pressKey('s');
    expect(onNavigate).toHaveBeenLastCalledWith({ view: 'sheet', date: null });
    expect(document.activeElement).toBe(button('Clockspan'));
    cleanup();
    onNavigate = await renderHeader(TODAY, 'board');
    expect(keys('Board')).toBe('B');
    pressKey('b');
    expect(onNavigate).toHaveBeenLastCalledWith({ view: 'sheet' });
    expect(onNavigate).toHaveBeenCalledOnce();
    cleanup();
    onNavigate = await renderHeader(TODAY, 'sheet');
    pressKey('h');
    expect(onNavigate).toHaveBeenLastCalledWith({ view: 'history' });
    expect(document.activeElement).toBe(button('History'));
    pressKey('b');
    expect(onNavigate).toHaveBeenLastCalledWith({ view: 'board' });
    expect(document.activeElement).toBe(button('Board'));
  });

  // A toggle's name stays put and aria-pressed says whether it is on, as Board's and History's do.
  it('keeps Customize named Customize, on or off, with aria-pressed saying which', async () => {
    for (const customize of [false, true]) {
      await renderHeader(TODAY, 'sheet', { customize });
      const button = screen.getByRole('button', { name: 'Customize' });
      expect(button.getAttribute('aria-pressed')).toBe(String(customize));
      expect(button.title).toBe('Customize layout');
      cleanup();
    }
  });

  // Until the settings answer, the sheet shows the default layout, and any change would save it whole.
  it("keeps Customize disabled until the settings have loaded, so a press before that can't change the layout", async () => {
    const settings = deferredAnswer<Settings>();
    vi.mocked(api.getSettings).mockReturnValue(settings.promise);
    const onToggleCustomize = vi.fn();
    await renderHeader(TODAY, 'sheet', { onToggleCustomize });
    const button = screen.getByRole('button', { name: 'Customize' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onToggleCustomize).not.toHaveBeenCalled();
    settings.resolve(makeSettings());
    await settle();
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(onToggleCustomize).toHaveBeenCalledTimes(1);
  });

  // Customize, Board, History, Settings and Sign out leave no room on a phone for the brand's name;
  // every view keeps the same header, so a page switch moves nothing.
  it('marks the row crowded on every view with someone signed in; the brand keeps its name', async () => {
    const crowded = () => document.querySelector('.topbar-row--crowded') !== null;
    for (const view of VIEWS) {
      await renderHeader(TODAY, view, { auth: makeAuth({ user: DEFAULT_USER }) });
      expect(crowded(), view).toBe(true);
      expect(screen.getByRole('button', { name: 'Clockspan' })).toBeTruthy();
      cleanup();
    }
    await renderHeader(TODAY, 'sheet');
    expect(crowded()).toBe(false);
  });

  it('sends Today to the null route, handing the focus to Previous day as Today goes', async () => {
    const onNavigate = await renderHeader(YESTERDAY);
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(onNavigate).toHaveBeenCalledWith({ date: null });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Previous day' }));
  });

  it('hands the focus to Previous day when Next day reaches today and is disabled', async () => {
    const onNavigate = await renderHeader(addDays(YESTERDAY, -1));
    fireEvent.click(screen.getByRole('button', { name: 'Next day' }));
    expect(onNavigate).toHaveBeenLastCalledWith({ date: YESTERDAY });
    expect(document.activeElement).toBe(document.body);
    cleanup();

    const fromYesterday = await renderHeader(YESTERDAY);
    fireEvent.click(screen.getByRole('button', { name: 'Next day' }));
    expect(fromYesterday).toHaveBeenLastCalledWith({ date: TODAY });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Previous day' }));
  });

  it('adds one history entry per visit to or click on the date field, and skips a part-typed year', async () => {
    const onNavigate = await renderHeader(TODAY);
    const field = screen.getByLabelText('Pick a date');
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: '0002-08-28' } });
    fireEvent.change(field, { target: { value: '0202-08-28' } });
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: '2026-08-28' } });
    fireEvent.change(field, { target: { value: '2026-01-28' } });
    fireEvent.change(field, { target: { value: '' } });
    expect(onNavigate.mock.calls).toEqual([
      [{ date: '2026-08-28' }, { replace: false }],
      [{ date: '2026-01-28' }, { replace: true }],
    ]);
    fireEvent.blur(field);
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: '2026-02-28' } });
    expect(onNavigate).toHaveBeenLastCalledWith({ date: '2026-02-28' }, { replace: false });
    fireEvent.click(field);
    fireEvent.change(field, { target: { value: '2026-03-28' } });
    expect(onNavigate).toHaveBeenLastCalledWith({ date: '2026-03-28' }, { replace: false });
  });

  // A future date shows today and the date already shown moves nothing: neither added an entry, so the next change must.
  it('adds the entry on the first change that moves the sheet', async () => {
    const onNavigate = await renderHeader(TODAY);
    const field = screen.getByLabelText('Pick a date');
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: '2999-01-01' } });
    fireEvent.change(field, { target: { value: TODAY } });
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: YESTERDAY } });
    expect(onNavigate.mock.calls).toEqual([[{ date: YESTERDAY }, { replace: false }]]);
  });

  it('opens the date picker once from a click on the label', async () => {
    const showPicker = vi.fn();
    setShowPicker(showPicker);
    await renderHeader(TODAY);
    fireEvent.click(screen.getByText('Today'));
    expect(showPicker).toHaveBeenCalledTimes(1);
  });

  it('raises no error from a click in a browser without showPicker', async () => {
    setShowPicker(undefined);
    // React reports an error thrown in a handler as an `error` event on the window, not to the caller.
    const errors = vi.fn((e: Event) => e.preventDefault());
    window.addEventListener('error', errors);
    await renderHeader(TODAY);
    fireEvent.click(screen.getByLabelText('Pick a date'));
    window.removeEventListener('error', errors);
    expect(errors).not.toHaveBeenCalled();
  });
});
