// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../api';
import { DELETE_DAYS } from '../../lib/copy';
import { makeSettings, settle, T0, TODAY } from '../../test/hooks';
import { DataTab } from './DataTab';

vi.mock('../../api');

async function renderTab() {
  render(<DataTab settings={makeSettings()} set={vi.fn()} onReset={vi.fn()} />);
  await settle();
  return {
    date: screen.getByLabelText('Delete days before') as HTMLInputElement,
    button: screen.getByRole('button', { name: 'Delete…' }) as HTMLButtonElement,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  vi.mocked(api.getPruneInfo).mockImplementation((before) => Promise.resolve({ before, matching: 2, total: 4, oldest: '2026-09-01', serverMaxDays: null }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe('DataTab', () => {
  it('clamps a typed date after today to today, and keeps the count when that is already the cutoff', async () => {
    const { date, button } = await renderTab();
    fireEvent.change(date, { target: { value: '2026-10-05' } });
    await settle();
    expect(api.getPruneInfo).toHaveBeenLastCalledWith(TODAY);
    expect(screen.getByText(/2 before this date/)).toBeTruthy();

    fireEvent.change(date, { target: { value: '2026-10-09' } });
    await settle();
    expect(date.value).toBe(TODAY);
    expect(screen.getByText(/2 before this date/)).toBeTruthy();
    expect(button.disabled).toBe(false);
  });

  it('announces a finished delete as a status line', async () => {
    vi.mocked(api.pruneDays).mockResolvedValue({ deleted: 2 });
    vi.stubGlobal('confirm', () => true);
    const { button } = await renderTab();
    fireEvent.click(button);
    await settle();
    expect(screen.getByRole('status').textContent).toBe(DELETE_DAYS.done(2));
  });
});
