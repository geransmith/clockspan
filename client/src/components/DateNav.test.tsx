// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays } from '../../../shared/dates.js';
import * as api from '../api';
import { SettingsProvider } from '../hooks/useSettings';
import { answered, deferredAnswer, makeSettings, settle, TODAY, YESTERDAY } from '../test/hooks';
import type { Settings } from '../types';
import { DateNav } from './DateNav';

vi.mock('../api');

async function renderNav(date: string, { customize = false, onToggleCustomize = vi.fn() } = {}) {
  const onNavigate = vi.fn();
  render(
    <SettingsProvider>
      <DateNav date={date} today={TODAY} customize={customize} onNavigate={onNavigate} onToggleCustomize={onToggleCustomize} />
    </SettingsProvider>,
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

describe('DateNav', () => {
  it('sends Today to the null route, handing the focus to Previous day as Today goes', async () => {
    const onNavigate = await renderNav(YESTERDAY);
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(onNavigate).toHaveBeenCalledWith({ date: null });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Previous day' }));
  });

  it('hands the focus to Previous day when Next day reaches today and is disabled', async () => {
    const onNavigate = await renderNav(addDays(YESTERDAY, -1));
    fireEvent.click(screen.getByRole('button', { name: 'Next day' }));
    expect(onNavigate).toHaveBeenLastCalledWith({ date: YESTERDAY });
    expect(document.activeElement).toBe(document.body);
    cleanup();

    const fromYesterday = await renderNav(YESTERDAY);
    fireEvent.click(screen.getByRole('button', { name: 'Next day' }));
    expect(fromYesterday).toHaveBeenLastCalledWith({ date: TODAY });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Previous day' }));
  });

  it('adds one history entry per visit to or click on the date field, and skips a part-typed year', async () => {
    const onNavigate = await renderNav(TODAY);
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
    const onNavigate = await renderNav(TODAY);
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
    await renderNav(TODAY);
    fireEvent.click(screen.getByText('Today'));
    expect(showPicker).toHaveBeenCalledTimes(1);
  });

  it('raises no error from a click in a browser without showPicker', async () => {
    setShowPicker(undefined);
    // React reports an error thrown in a handler as an `error` event on the window, not to the caller.
    const errors = vi.fn((e: Event) => e.preventDefault());
    window.addEventListener('error', errors);
    await renderNav(TODAY);
    fireEvent.click(screen.getByLabelText('Pick a date'));
    window.removeEventListener('error', errors);
    expect(errors).not.toHaveBeenCalled();
  });

  // A toggle's name stays put and aria-pressed says whether it is on, as Board's and History's do.
  it('keeps Customize named Customize, on or off, with aria-pressed saying which', async () => {
    for (const customize of [false, true]) {
      await renderNav(TODAY, { customize });
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
    await renderNav(TODAY, { onToggleCustomize });
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
});
