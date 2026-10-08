// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LEFT_OPEN, TODAY_OFFER } from '../lib/copy';
import { planNext, type PrioritySeed } from '../lib/plan';
import { makeRecurring } from '../test/fixtures';
import type { Recurring } from '../types';
import { TodayOffer } from './TodayOffer';

const QUEUE = makeRecurring('rcur00000001', 'Monitor the queue');
const FOLLOW_UPS = makeRecurring('rcur00000002', 'Follow-ups');
const STANDUP = makeRecurring('rcur00000003', 'Standup notes');
const INVOICES: PrioritySeed = { text: 'Invoices', cardUid: 'card00000001', recurringUid: null, categoryUid: null };
const EMAIL: PrioritySeed = { text: 'Email', cardUid: null, recurringUid: null, categoryUid: null };

const box = (name: string) => (screen.getByRole('checkbox', { name }) as HTMLInputElement).checked;

afterEach(cleanup);

it('keeps a box pressed by its item while the groups change around it, and starts an item that comes later as it should', () => {
  const onAdd = vi.fn<(leftovers: PrioritySeed[], recurring: Recurring[]) => void>();
  const offer = (leftovers: PrioritySeed[], recurring: Recurring[]) => (
    <TodayOffer leftovers={{ from: 'yesterday', rows: leftovers }} recurring={recurring} rows={[]} perDay={2} onAdd={onAdd} onSkip={vi.fn()} />
  );
  const { rerender } = render(offer([INVOICES, EMAIL], [QUEUE, STANDUP]));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Monitor the queue' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Email' }));
  expect([box('Monitor the queue'), box('Standup notes'), box('Email')]).toEqual([false, true, false]);
  // A board read brings Follow-ups ahead of the others and retitles the card's leftover. The boxes
  // pressed keep their answer; the others start as the new order says, the first two ticked.
  rerender(offer([{ ...INVOICES, text: 'Invoices for Acme' }, EMAIL], [FOLLOW_UPS, QUEUE, STANDUP]));
  expect([box('Follow-ups'), box('Monitor the queue'), box('Standup notes'), box('Email'), box('Invoices for Acme')]).toEqual([
    true,
    false,
    false,
    false,
    true,
  ]);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Standup notes' }));
  fireEvent.click(screen.getByRole('button', { name: LEFT_OPEN.add }));
  expect(onAdd).toHaveBeenCalledExactlyOnceWith([{ ...INVOICES, text: 'Invoices for Acme' }], [FOLLOW_UPS, STANDUP]);
});

it('shows a leftover once when Add would bring it once: the same text however it is typed, or the same card', () => {
  const onAdd = vi.fn<(leftovers: PrioritySeed[], recurring: Recurring[]) => void>();
  const rows = [INVOICES, { ...EMAIL, text: 'invoices ' }, EMAIL, { ...EMAIL, text: ' email' }, { ...INVOICES, text: 'Invoices for Acme' }];
  render(<TodayOffer leftovers={{ from: 'yesterday', rows }} recurring={[]} rows={[]} perDay={1} onAdd={onAdd} onSkip={vi.fn()} />);
  const labels = screen.getAllByRole('checkbox').map((b) => b.closest('label')!.textContent);
  expect(labels).toEqual(['Invoices', 'Email']);
  expect(planNext([], rows).rows.map((p) => p.text)).toEqual(labels);
  fireEvent.click(screen.getByRole('button', { name: LEFT_OPEN.add }));
  expect(onAdd).toHaveBeenCalledExactlyOnceWith([INVOICES, EMAIL], []);
});

it('names each group by its heading, so a leftover and a routine of one title are told apart', () => {
  const leftover = { ...EMAIL, text: 'Monitor the queue' };
  render(<TodayOffer leftovers={{ from: 'yesterday', rows: [leftover] }} recurring={[QUEUE]} rows={[]} perDay={1} onAdd={vi.fn()} onSkip={vi.fn()} />);
  const groups = [screen.getByRole('group', { name: LEFT_OPEN.title('yesterday') }), screen.getByRole('group', { name: TODAY_OFFER.recurring })];
  const [fromYesterday, repeats] = groups.map((g) => within(g).getByRole('checkbox', { name: 'Monitor the queue' }));
  expect(fromYesterday).not.toBe(repeats);
});
