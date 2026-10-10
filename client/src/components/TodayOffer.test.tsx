// @vitest-environment happy-dom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { LEFT_OPEN, TODAY_OFFER } from '../lib/copy';
import type { PrioritySeed } from '../lib/plan';
import { makeRecurring } from '../test/fixtures';
import type { Recurring } from '../types';
import { TodayOffer } from './TodayOffer';

const QUEUE = makeRecurring('rcur00000001', 'Monitor the queue');
const FOLLOW_UPS = makeRecurring('rcur00000002', 'Follow-ups');
const STANDUP = makeRecurring('rcur00000003', 'Standup notes');
const INVOICES: PrioritySeed = { uid: 'invoices0001', text: 'Invoices', categoryUid: null, note: '', listed: 0, earlier: 0, logged: 0 };
const EMAIL: PrioritySeed = { uid: 'email0000001', text: 'Email', categoryUid: null, note: '', listed: 0, earlier: 0, logged: 0 };
const card = (uid: string, text: string): PrioritySeed => ({ ...EMAIL, uid, text });
const ACME = card('next00000001', 'Follow up on the Acme SLA');
const ROTA = card('next00000002', 'Draft the rota');
const KB = card('next00000003', 'Write a KB');

const box = (name: string) => (screen.getByRole('checkbox', { name }) as HTMLInputElement).checked;

it('keeps a box pressed by its item while the groups change around it, and starts an item that comes later as it should', () => {
  const onAdd = vi.fn<(leftovers: PrioritySeed[], recurring: Recurring[]) => void>();
  const offer = (leftovers: PrioritySeed[], recurring: Recurring[]) => (
    <TodayOffer
      upNext={[]}
      rowsPerDay={3}
      leftovers={{ from: 'yesterday', rows: leftovers }}
      recurring={recurring}
      rows={[]}
      perDay={2}
      onAdd={onAdd}
      onSkip={vi.fn()}
    />
  );
  const { rerender } = render(offer([INVOICES, EMAIL], [QUEUE, STANDUP]));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Monitor the queue' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Email' }));
  expect([box('Monitor the queue'), box('Standup notes'), box('Email')]).toEqual([false, true, false]);
  // A board read brings Follow-ups ahead of the others, and another device renamed a leftover. The
  // boxes pressed keep their answer; the others start as the new order says, the first two ticked.
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

it('keeps a leftover pressed by its task through a rename', () => {
  const onAdd = vi.fn<(leftovers: PrioritySeed[], recurring: Recurring[]) => void>();
  const offer = (rows: PrioritySeed[]) => (
    <TodayOffer upNext={[]} rowsPerDay={3} leftovers={{ from: 'yesterday', rows }} recurring={[]} rows={[]} perDay={1} onAdd={onAdd} onSkip={vi.fn()} />
  );
  const { rerender } = render(offer([INVOICES, EMAIL]));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Invoices' }));
  rerender(offer([{ ...INVOICES, text: 'Invoices for Acme' }, EMAIL]));
  expect([box('Invoices for Acme'), box('Email')]).toEqual([false, true]);
  fireEvent.click(screen.getByRole('button', { name: LEFT_OPEN.add }));
  expect(onAdd).toHaveBeenCalledExactlyOnceWith([EMAIL], []);
});

it('names each group by its heading, so a leftover and a routine of one title are told apart', () => {
  const leftover = { ...EMAIL, text: 'Monitor the queue' };
  render(
    <TodayOffer
      upNext={[]}
      rowsPerDay={3}
      leftovers={{ from: 'yesterday', rows: [leftover] }}
      recurring={[QUEUE]}
      rows={[]}
      perDay={1}
      onAdd={vi.fn()}
      onSkip={vi.fn()}
    />,
  );
  const groups = [screen.getByRole('group', { name: LEFT_OPEN.title('yesterday') }), screen.getByRole('group', { name: TODAY_OFFER.recurring })];
  const [fromYesterday, repeats] = groups.map((g) => within(g).getByRole('checkbox', { name: 'Monitor the queue' }));
  expect(fromYesterday).not.toBe(repeats);
});

it('ticks Up next to fill Rows per day after the leftovers, and adds the ticked ones after them', () => {
  const onAdd = vi.fn<(seeds: PrioritySeed[], recurring: Recurring[]) => void>();
  const offer = (upNext: PrioritySeed[]) => (
    <TodayOffer
      leftovers={{ from: 'yesterday', rows: [INVOICES] }}
      upNext={upNext}
      rowsPerDay={3}
      recurring={[QUEUE]}
      rows={[]}
      perDay={1}
      onAdd={onAdd}
      onSkip={vi.fn()}
    />
  );
  const { rerender } = render(offer([ACME, ROTA, KB]));
  const upNext = screen.getByRole('group', { name: TODAY_OFFER.upNext });
  expect(
    within(upNext)
      .getAllByRole('checkbox')
      .map((b) => (b as HTMLInputElement).checked),
  ).toEqual([true, true, false]);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Write a KB' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Draft the rota' }));
  // Another device moved the rota to the top of Next: the boxes pressed keep their answer.
  rerender(offer([ROTA, ACME, KB]));
  expect([box('Draft the rota'), box('Follow up on the Acme SLA'), box('Write a KB')]).toEqual([false, true, true]);
  fireEvent.click(screen.getByRole('button', { name: LEFT_OPEN.add }));
  expect(onAdd).toHaveBeenCalledExactlyOnceWith([INVOICES, ACME, KB], [QUEUE]);
});

it('ticks the first Rows per day of Up next with nothing left open', () => {
  const onAdd = vi.fn<(seeds: PrioritySeed[], recurring: Recurring[]) => void>();
  render(<TodayOffer leftovers={null} upNext={[ACME, ROTA, KB]} rowsPerDay={2} recurring={[]} rows={[]} perDay={1} onAdd={onAdd} onSkip={vi.fn()} />);
  expect([box('Follow up on the Acme SLA'), box('Draft the rota'), box('Write a KB')]).toEqual([true, true, false]);
  fireEvent.click(screen.getByRole('button', { name: LEFT_OPEN.add }));
  expect(onAdd).toHaveBeenCalledExactlyOnceWith([ACME, ROTA], []);
});

it('ticks none of Up next once the leftovers fill Rows per day', () => {
  render(
    <TodayOffer
      leftovers={{ from: 'yesterday', rows: [INVOICES, EMAIL] }}
      upNext={[ACME]}
      rowsPerDay={1}
      recurring={[]}
      rows={[]}
      perDay={1}
      onAdd={vi.fn()}
      onSkip={vi.fn()}
    />,
  );
  expect([box('Invoices'), box('Email'), box('Follow up on the Acme SLA')]).toEqual([true, true, false]);
});
