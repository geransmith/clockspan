import { useEffect, useRef, useState, type RefObject } from 'react';
import { playSound } from '../lib/alerts';
import { BURST_MS } from '../lib/celebrate';
import type { SoundEvent } from '../types';
import { useLatest } from './useLatest';
import { useSettings } from './useSettings';

/** A moment to celebrate; a fresh object each time, so the same thing happening again counts. */
export type Moment = object;

export interface BurstAt {
  seed: number;
  anchor: DOMRect;
}

/**
 * `value` turning true while the component is mounted, as a fresh `Moment` each time. A value
 * that was already true when it first became known (a done day opened later, a week that
 * loads past its target) is not one, and `null` means "not known": a change to or from it is
 * never a moment. "Adjust state while rendering", so the moment exists in the same render as
 * whatever it celebrates.
 */
export function useBecameTrue(value: boolean | null): Moment | null {
  const [was, setWas] = useState(value);
  const [moment, setMoment] = useState<Moment | null>(null);
  if (value !== was) {
    setWas(value);
    if (value && was === false) setMoment({});
  }
  return moment;
}

/**
 * Plays `sound`'s pick under the master sound switch and, with Celebrations on, returns an
 * emoji burst from the element holding `anchor` for as long as one lives. The anchor is
 * measured once the moment has rendered, so it can be the notice that appears with it. The
 * settings are read through a ref instead of listed as a dependency, so a later settings change
 * doesn't rerun the effect for the last moment and play its sound or burst again.
 */
export function useCelebration<T extends HTMLElement>(moment: Moment | null, sound: SoundEvent): { anchor: RefObject<T | null>; burst: BurstAt | null } {
  const { settings } = useSettings();
  const latest = useLatest(settings);
  const anchor = useRef<T>(null);
  // Kept with its moment: a newer moment hides a burst still flying from the last one.
  const [burst, setBurst] = useState<{ moment: Moment; at: BurstAt } | null>(null);
  useEffect(() => {
    if (!moment) return;
    const s = latest.current;
    if (s.sound) playSound(s.sounds[sound]);
    const rect = s.celebrations ? anchor.current?.getBoundingClientRect() : undefined;
    if (!rect) return;
    setBurst({ moment, at: { seed: Date.now(), anchor: rect } });
    const id = window.setTimeout(() => setBurst(null), BURST_MS);
    return () => window.clearTimeout(id);
  }, [moment, sound, latest]);
  return { anchor, burst: burst && burst.moment === moment ? burst.at : null };
}
