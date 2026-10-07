// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../api';
import { CONFIRM, DAYS_DELETED } from '../../lib/copy';
import { formatDateFull } from '../../lib/format';
import { deferred, makeBoard, makeSettings, settle, SettingsAndDays, T0, TODAY } from '../../test/hooks';
import type { Board, PruneResult } from '../../types';
import { DataTab } from './DataTab';

vi.mock('../../api');

async function renderTab(settings = makeSettings()) {
  const set = vi.fn();
  render(<DataTab settings={settings} set={set} onReset={vi.fn()} />, { wrapper: SettingsAndDays });
  await settle();
  return {
    set,
    date: screen.getByLabelText('Delete days before') as HTMLInputElement,
    button: screen.getByRole('button', { name: 'Delete…' }) as HTMLButtonElement,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  vi.mocked(api.getSettings).mockResolvedValue(makeSettings());
  vi.mocked(api.getPruneInfo).mockImplementation((before) => Promise.resolve({ before, matching: 2, total: 4, oldest: '2026-09-01', serverMaxDays: null }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('DataTab', () => {
  it('turns the automatic cleanup on without sending the days to keep', async () => {
    const { set } = await renderTab();
    fireEvent.click(screen.getByRole('switch', { name: 'Delete old days automatically' }));
    expect(set).toHaveBeenCalledWith({ retention: { enabled: true } });
  });

  it('saves the days to keep without sending the switch', async () => {
    const { set } = await renderTab(makeSettings({ retention: { enabled: true, days: 365 } }));
    const keep = screen.getByLabelText('Keep the last');
    fireEvent.change(keep, { target: { value: '90' } });
    fireEvent.blur(keep);
    expect(set).toHaveBeenCalledWith({ retention: { days: 90 } });
  });

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

  it('deletes before the picked date after a confirm that names the count, and says how many went', async () => {
    vi.mocked(api.pruneDays).mockResolvedValue({ deleted: 2 });
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    const { date, button } = await renderTab();
    fireEvent.change(date, { target: { value: '2026-06-01' } });
    await settle();
    // The live region is there before its text, or a screen reader may not read the text out.
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('');
    fireEvent.click(button);
    await settle();
    expect(confirm).toHaveBeenCalledWith(CONFIRM.deleteDays(2, formatDateFull('2026-06-01')));
    expect(api.pruneDays).toHaveBeenCalledWith('2026-06-01');
    expect(screen.getByRole('status')).toBe(status);
    expect(status.textContent).toBe(DAYS_DELETED(2));
  });

  it("shows the new date's count when the date changes during a delete", async () => {
    const later = '2026-01-01';
    vi.mocked(api.getPruneInfo).mockImplementation((before) =>
      Promise.resolve({ before, matching: before === later ? 5 : 2, total: 9, oldest: '2025-01-01', serverMaxDays: null }),
    );
    const prune = deferred<PruneResult>();
    vi.mocked(api.pruneDays).mockReturnValue(prune.promise);
    vi.stubGlobal('confirm', () => true);
    const { date, button } = await renderTab();
    fireEvent.click(button);
    fireEvent.change(date, { target: { value: later } });
    await settle();
    prune.resolve({ deleted: 2 });
    await settle();
    expect(api.getPruneInfo).toHaveBeenLastCalledWith(later);
    expect(screen.getByText(/5 before this date/)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe(DAYS_DELETED(2));
    expect(button.disabled).toBe(false);
  });

  it('reads the board again after a delete, once a read still out has answered', async () => {
    vi.mocked(api.pruneDays).mockResolvedValue({ deleted: 2 });
    vi.mocked(api.getSettings).mockResolvedValue(makeSettings({ board: true }));
    // The read the board sent as it came on is still out when the delete lands, and may be older.
    const first = deferred<Board>();
    vi.mocked(api.getBoard).mockReturnValueOnce(first.promise).mockResolvedValue(makeBoard());
    vi.stubGlobal('confirm', () => true);
    const { button } = await renderTab();
    expect(api.getBoard).toHaveBeenCalledTimes(1);
    fireEvent.click(button);
    await settle();
    expect(api.pruneDays).toHaveBeenCalledTimes(1);
    expect(api.getBoard).toHaveBeenCalledTimes(1);
    first.resolve(makeBoard());
    await settle();
    expect(api.getBoard).toHaveBeenCalledTimes(2);
  });

  it('keeps the result when the count after a delete fails, with Delete off', async () => {
    vi.mocked(api.pruneDays).mockResolvedValue({ deleted: 2 });
    vi.stubGlobal('confirm', () => true);
    const { button } = await renderTab();
    vi.mocked(api.getPruneInfo).mockRejectedValueOnce(new Error('Request failed (500)'));
    fireEvent.click(button);
    await settle();
    expect(screen.getByRole('status').textContent).toBe(DAYS_DELETED(2));
    expect(screen.getByRole('alert').textContent).toBe('Request failed (500)');
    expect(button.disabled).toBe(true);
  });
});
