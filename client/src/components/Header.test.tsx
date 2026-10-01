// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays } from '../../../shared/dates.js';
import * as api from '../api';
import { AuthGate } from '../auth/AuthGate';
import { settle, TODAY } from '../test/hooks';
import { Header } from './Header';

// The header reads the signed-in user from AuthGate, which needs an answer from getAuth and the real event name.
vi.mock('../api', async (importOriginal) => {
  const { UNAUTHENTICATED_EVENT } = await importOriginal<typeof import('../api')>();
  return { UNAUTHENTICATED_EVENT, getAuth: vi.fn(), logout: vi.fn() };
});

async function renderHeader(date: string) {
  const onNavigate = vi.fn();
  vi.mocked(api.getAuth).mockResolvedValue({ mode: 'none', setupRequired: false, user: null, cookieSecure: false });
  render(
    <AuthGate>
      <Header view="sheet" date={date} today={TODAY} customize={false} onNavigate={onNavigate} onToggleCustomize={vi.fn()} onOpenSettings={vi.fn()} />
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
  vi.resetAllMocks();
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

  it('sends Today to the null route', async () => {
    const onNavigate = await renderHeader(addDays(TODAY, -1));
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(onNavigate).toHaveBeenCalledWith({ date: null });
  });

  it('opens the date picker once from a click on the label', async () => {
    const showPicker = vi.fn();
    setShowPicker(showPicker);
    await renderHeader(TODAY);
    fireEvent.click(screen.getByText('Today'));
    expect(showPicker).toHaveBeenCalledTimes(1);
  });

  it('leaves a browser without showPicker to focus the field', async () => {
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
