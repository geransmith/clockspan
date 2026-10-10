import { useId, useState } from 'react';
import { LEFT_OPEN, TODAY_OFFER } from '../lib/copy';
import type { PrioritySeed } from '../lib/plan';
import { offerPicks, recurringCount } from '../lib/recurring';
import type { Priority, Recurring } from '../types';

/** What the last planned day left unticked, offered on today's list: `from` names that day as `dayName(date, today, true)` does. */
interface Leftovers {
  from: string;
  rows: PrioritySeed[];
}

/**
 * Today's morning notice on Top priorities, as the sheet hands it down: what the last planned day
 * left unticked, the top of Next and the recurring priorities due today. The card shows each group
 * while its list doesn't hold it yet.
 */
export interface MorningOffer {
  /** The leftovers as seeds (`offeredLeftovers`), null with none. */
  leftovers: Leftovers | null;
  /** The top of Next as seeds (`topOfNext`); none until the leftovers' read and the board's have answered. */
  upNext: PrioritySeed[];
  /** The recurring priorities due today and not answered on this device yet, in Settings order (`dueRecurring`); none before the board's first read. */
  recurring: Recurring[];
  /**
   * Records what the notice showed once Add to today, Not today or Start fresh is pressed: the
   * routines shown, ticked or not, are answered for today on this device, and leftovers or Up
   * next shown hold Start fresh for the day.
   */
  answer: (shownRecurring: string[], oneOffsShown: boolean) => void;
}

interface Props {
  /** The leftovers group, null while it isn't shown. */
  leftovers: Leftovers | null;
  /** The Up next group, empty while it isn't shown. */
  upNext: PrioritySeed[];
  /** Rows per day: the leftovers, all ticked, and then Up next's first boxes fill it. */
  rowsPerDay: number;
  /** The routines shown, in Settings order. */
  recurring: Recurring[];
  /** Today's list as the card shows it: the routines on it count toward `perDay`. */
  rows: Priority[];
  /** Recurring rows per day: how many routines the notice ticks, less those on `rows`. */
  perDay: number;
  /** Add to today, with the items ticked: the leftovers and then Up next's, as `seeds`. */
  onAdd: (seeds: PrioritySeed[], recurring: Recurring[]) => void;
  /** Not today, or Start fresh with no routine shown. */
  onSkip: () => void;
}

/** A leftover's or Up next's key: its task (a day's list holds a task once, so each is one box). */
const leftoverKey = (seed: PrioritySeed) => `task:${seed.uid ?? seed.text}`;
const recurringKey = (item: Recurring) => `rcur:${item.uid}`;

/**
 * One calm notice with three groups, "Still open from …", "Up next" and "Repeats today", each item
 * a box to tick. Leftovers start ticked; Up next up to `rowsPerDay` less the leftovers; routines up
 * to `perDay` less those already on the list (`offerPicks`), and the rest unticked. A box pressed
 * keeps its answer while the groups change around it (an item read from the board later still
 * starts as it should). Ticking more routines than `perDay` says so, and Add to today adds them
 * all the same.
 */
export function TodayOffer({ leftovers, upNext, rowsPerDay, recurring, rows, perDay, onAdd, onSkip }: Props) {
  const [pressed, setPressed] = useState<ReadonlyMap<string, boolean>>(new Map());
  const press = (key: string, on: boolean) => setPressed((m) => new Map(m).set(key, on));
  const ticked = (key: string, byDefault: boolean) => pressed.get(key) ?? byDefault;

  // Each group is named by its heading, so a box tabbed to says which group it is in.
  const leftoversId = useId();
  const upNextId = useId();
  const recurringId = useId();
  const seeds = leftovers?.rows ?? [];
  const room = Math.max(0, rowsPerDay - seeds.length);
  const upNextTicked = (seed: PrioritySeed, i: number) => ticked(leftoverKey(seed), i < room);
  const picks = offerPicks(recurring, rows, perDay);
  const tickedSeeds = seeds.filter((seed) => ticked(leftoverKey(seed), true));
  const tickedUpNext = upNext.filter(upNextTicked);
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
      {upNext.length > 0 && (
        <div className="left-open-list" role="group" aria-labelledby={upNextId}>
          <strong id={upNextId}>{TODAY_OFFER.upNext}</strong>
          <ul>{upNext.map((seed, i) => box(leftoverKey(seed), upNextTicked(seed, i), seed.text))}</ul>
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
        <button className="btn" onClick={() => onAdd([...tickedSeeds, ...tickedUpNext], tickedRecurring)}>
          {LEFT_OPEN.add}
        </button>
        <button className="btn btn-ghost" onClick={onSkip}>
          {recurring.length > 0 ? TODAY_OFFER.notToday : LEFT_OPEN.dismiss}
        </button>
      </span>
    </div>
  );
}
