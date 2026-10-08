import { useId, useState } from 'react';
import { LEFT_OPEN, TODAY_OFFER } from '../lib/copy';
import type { PrioritySeed } from '../lib/plan';
import { offerPicks, recurringCount } from '../lib/recurring';
import type { Priority, Recurring } from '../types';

/** What the last planned day left unticked, offered on today's list: `from` names that day as `dayName(date, today, true)` does. */
export interface Leftovers {
  from: string;
  rows: PrioritySeed[];
}

/**
 * Today's morning notice on Top priorities with the board on, as the sheet hands it down: what
 * the last planned day left unticked and the recurring priorities due today. The card shows each
 * group while its list doesn't hold it yet.
 */
export interface MorningOffer {
  /** The leftovers as seeds (`offeredLeftovers`), null with none. */
  leftovers: Leftovers | null;
  /** The recurring priorities due today and not answered on this device yet, in Settings order (`dueRecurring`). */
  recurring: Recurring[];
  /**
   * Records what the notice showed once Add to today, Not today or Start fresh is pressed: the
   * routines shown, ticked or not, are answered for today on this device, and leftovers shown
   * hold Start fresh for the day.
   */
  answer: (shownRecurring: string[], leftoversShown: boolean) => void;
}

interface Props {
  /** The leftovers group, null while it isn't shown. */
  leftovers: Leftovers | null;
  /** The routines shown, in Settings order. */
  recurring: Recurring[];
  /** Today's list as the card shows it: the routines on it count toward `perDay`. */
  rows: Priority[];
  /** Recurring rows per day: how many routines the notice ticks, less those on `rows`. */
  perDay: number;
  /** Add to today, with the items ticked. */
  onAdd: (leftovers: PrioritySeed[], recurring: Recurring[]) => void;
  /** Not today, or Start fresh with no routine shown. */
  onSkip: () => void;
}

/** A leftover's key: its task (a day's list holds a task once, so each is one box). */
const leftoverKey = (seed: PrioritySeed) => `task:${seed.uid ?? seed.text}`;
const recurringKey = (item: Recurring) => `rcur:${item.uid}`;

/**
 * One calm notice with two groups, "Still open from …" and "Repeats today", each item a box to
 * tick. Leftovers start ticked; routines up to `perDay` less those already on the list
 * (`offerPicks`), and the rest unticked. A box pressed keeps its answer while the groups change
 * around it (an item read from the board later still starts as it should). Ticking past
 * `perDay` says so, and Add to today adds them all the same.
 */
export function TodayOffer({ leftovers, recurring, rows, perDay, onAdd, onSkip }: Props) {
  const [pressed, setPressed] = useState<ReadonlyMap<string, boolean>>(new Map());
  const press = (key: string, on: boolean) => setPressed((m) => new Map(m).set(key, on));
  const ticked = (key: string, byDefault: boolean) => pressed.get(key) ?? byDefault;

  // Each group is named by its heading, so a box tabbed to says which group it is in.
  const leftoversId = useId();
  const recurringId = useId();
  const seeds = leftovers?.rows ?? [];
  const picks = offerPicks(recurring, rows, perDay);
  const tickedSeeds = seeds.filter((seed) => ticked(leftoverKey(seed), true));
  const tickedRecurring = recurring.filter((item) => ticked(recurringKey(item), picks.has(item.uid)));
  const over = tickedRecurring.length + recurringCount(rows) > perDay;

  const box = (key: string, checked: boolean, text: string) => (
    <li key={key}>
      <label className="inline-check">
        <input type="checkbox" className="checkbox" checked={checked} onChange={(e) => press(key, e.target.checked)} />
        <span>{text}</span>
      </label>
    </li>
  );

  return (
    <div className="notice notice--gentle left-open today-offer">
      {leftovers && (
        <div className="left-open-list" role="group" aria-labelledby={leftoversId}>
          <strong id={leftoversId}>{LEFT_OPEN.title(leftovers.from)}</strong>
          <ul>{seeds.map((seed) => box(leftoverKey(seed), ticked(leftoverKey(seed), true), seed.text))}</ul>
        </div>
      )}
      {recurring.length > 0 && (
        <div className="left-open-list" role="group" aria-labelledby={recurringId}>
          <strong id={recurringId}>{TODAY_OFFER.recurring}</strong>
          <ul>{recurring.map((item) => box(recurringKey(item), ticked(recurringKey(item), picks.has(item.uid)), item.title))}</ul>
          {/* Always there while the group is, so the line is heard when a tick brings it. */}
          <p className="muted small today-offer-over" role="status">
            {over ? TODAY_OFFER.over(perDay) : null}
          </p>
        </div>
      )}
      <span className="notice-actions">
        <button className="btn" onClick={() => onAdd(tickedSeeds, tickedRecurring)}>
          {LEFT_OPEN.add}
        </button>
        <button className="btn btn-ghost" onClick={onSkip}>
          {recurring.length > 0 ? TODAY_OFFER.notToday : LEFT_OPEN.dismiss}
        </button>
      </span>
    </div>
  );
}
