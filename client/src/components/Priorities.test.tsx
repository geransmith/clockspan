// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { SettingsProvider } from '../hooks/useSettings';
import { COMPLETE_WARNINGS, GENTLE_WARNINGS, LEFT_OPEN, WARNING_ACTIONS } from '../lib/copy';
import { makeSettings, settle, T0 } from '../test/hooks';
import type { Priority } from '../types';
import { Priorities } from './Priorities';

vi.mock('../api');
vi.mock('../lib/alerts');

const row = (position: number, text: string, done = false): Priority => ({ position, text, done, uid: `uid${position}abcdef`, addedAt: T0 });

async function renderCard(priorities: Priority[] = [], leftOpen?: Parameters<typeof Priorities>[0]['leftOpen']) {
  const onChange = vi.fn<(p: Priority[]) => void>();
  const view = render(
    <SettingsProvider>
      <Priorities priorities={priorities} onChange={onChange} leftOpen={leftOpen} />
    </SettingsProvider>,
  );
  await settle();
  return { ...view, onChange, saved: () => onChange.mock.lastCall![0] };
}

const textbox = (n: number) => screen.getByLabelText(`Priority ${n}`) as HTMLTextAreaElement;
const tick = (n: number) => screen.getByLabelText(`Priority ${n} done`) as HTMLInputElement;

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  vi.mocked(api.getSettings).mockResolvedValue(makeSettings());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('Priorities', () => {
  it('starts with the configured rows and saves text 400 ms after the last keystroke', async () => {
    const { onChange, saved } = await renderCard();
    expect(screen.getAllByRole('textbox')).toHaveLength(3);
    fireEvent.change(textbox(1), { target: { value: 'Write' } });
    fireEvent.change(textbox(1), { target: { value: 'Write the report' } });
    await settle(399);
    expect(onChange).not.toHaveBeenCalled();
    await settle(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    // The row gets its id and its time the first time it has text.
    expect(saved()[0]).toMatchObject({ position: 1, text: 'Write the report', done: false, addedAt: T0 });
    expect(saved()[0]!.uid).toMatch(/^[0-9a-f]{12}$/);
  });

  it('saves at once when the row is left, and keeps a pasted line break out', async () => {
    const { onChange, saved } = await renderCard();
    fireEvent.change(textbox(2), { target: { value: 'Call\nthe bank' } });
    fireEvent.blur(textbox(2));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(saved()[1]!.text).toBe('Call the bank');
    await settle(400);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('only ticks a row with text, and saves the tick straight away', async () => {
    const { onChange, saved } = await renderCard([row(1, 'Report')]);
    expect(tick(2).disabled).toBe(true);
    fireEvent.click(tick(1));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(saved()[0]).toMatchObject({ text: 'Report', done: true });
  });

  it('asks before a row past the usual count, then adds it; the extra row can be removed', async () => {
    const { onChange, saved } = await renderCard([row(1, 'Report')]);
    fireEvent.click(screen.getByRole('button', { name: 'Add priority' }));
    expect(onChange).not.toHaveBeenCalled();
    const status = screen.getByRole('status');
    expect(GENTLE_WARNINGS.some((w) => status.textContent!.includes(w))).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: WARNING_ACTIONS.fresh.keep }));
    expect(screen.queryByRole('status')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Add priority' }));
    fireEvent.click(screen.getByRole('button', { name: WARNING_ACTIONS.fresh.add }));
    expect(saved()).toHaveLength(4);
    expect(screen.getAllByRole('textbox')).toHaveLength(4);

    fireEvent.click(screen.getByRole('button', { name: 'Remove priority 4' }));
    expect(saved()).toHaveLength(3);
    // Rows inside the usual count have no remove button.
    expect(screen.queryByRole('button', { name: /Remove priority/ })).toBeNull();
  });

  it('with every row ticked, warns from the "complete" set and lists what is done', async () => {
    await renderCard([row(1, 'Report', true), row(2, 'Invoices', true), row(3, 'Email', true)]);
    fireEvent.click(screen.getByRole('button', { name: 'Add priority' }));
    const status = screen.getByRole('status');
    expect(COMPLETE_WARNINGS.some((w) => status.textContent!.includes(w))).toBe(true);
    expect(status.textContent).toContain('3 of 3 done');
    expect(screen.getByRole('button', { name: WARNING_ACTIONS.complete.add })).toBeTruthy();
  });

  it("takes the server's rows while nothing is being typed, and keeps a draft that is", async () => {
    const { rerender, onChange } = await renderCard([row(1, 'Report')]);
    const again = (rows: Priority[]) =>
      rerender(
        <SettingsProvider>
          <Priorities priorities={rows} onChange={onChange} />
        </SettingsProvider>,
      );
    again([row(1, 'Report from another device')]);
    expect(textbox(1).value).toBe('Report from another device');

    fireEvent.change(textbox(2), { target: { value: 'Half typed' } });
    again([row(1, 'Changed again')]);
    expect(textbox(2).value).toBe('Half typed');
    expect(textbox(1).value).toBe('Report from another device');
  });

  it("offers the last plan's open rows on an empty list, as new rows for today", async () => {
    const dismiss = vi.fn();
    const { saved } = await renderCard([], { from: 'yesterday', rows: [row(2, 'Invoices')], dismiss });
    expect(screen.getByText(LEFT_OPEN.title('yesterday'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: LEFT_OPEN.dismiss }));
    expect(dismiss).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: LEFT_OPEN.add }));
    expect(saved()[0]).toMatchObject({ position: 1, text: 'Invoices', done: false });
    expect(saved()[0]!.uid).not.toBe('uid2abcdef');
  });
});
