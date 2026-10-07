// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { AuthGate } from '../auth/AuthGate';
import { VIEWS, type Route } from '../hooks/useRoute';
import { DEFAULT_USER, makeAuth, settle, TODAY, YESTERDAY } from '../test/hooks';
import { Header } from './Header';

vi.mock('../api');

async function renderHeader(date: string, view: Route['view'] = 'sheet') {
  const onNavigate = vi.fn();
  vi.mocked(api.getAuth).mockResolvedValue(makeAuth({ mode: 'none', user: DEFAULT_USER }));
  render(
    <AuthGate>
      <Header view={view} date={date} today={TODAY} customize={false} onNavigate={onNavigate} onToggleCustomize={vi.fn()} onOpenSettings={vi.fn()} />
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
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
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

  it('sends Today to the null route', async () => {
    const onNavigate = await renderHeader(YESTERDAY);
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(onNavigate).toHaveBeenCalledWith({ date: null });
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
