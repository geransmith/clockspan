import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useDateSegment, useLocale, useTimeField } from 'react-aria';
import { useTimeFieldState, type DateFieldState, type DateSegment } from 'react-stately';
import type { Time } from '@internationalized/date';
import { useLatest } from '../hooks/useLatest';
import { guessPeriod, msToTime, timeToMs } from '../lib/timefield';

interface Props {
  /** The stored instant, or null for an empty row. */
  value: number | null;
  date: string;
  hour12: boolean;
  /** The day's clock-in when this is a later punch: the AM/PM guess keeps the time after it. */
  anchorAt: number | null;
  label: string;
  /** Called with a complete time only; clearing is the row's own button. */
  onCommit: (ms: number) => void;
  /** Focus entered or left the field; a field removed with focus inside reports leaving. */
  onFocusChange?: (focused: boolean) => void;
  /** The id of a message saying this time is wrong: the field reads as invalid and is described by it. */
  errorId?: string;
}

/**
 * Hour / minute / AM-PM segments on React Aria: typing advances, ↑/↓ step, `a`/`p` set the
 * period. The value saves the moment every segment is filled, and a half-typed draft is
 * thrown away when focus leaves the field, so the row never shows a time it hasn't stored.
 * Escape throws the draft away too, and puts focus back on the new field's first segment.
 * Remounting is how the draft is discarded.
 */
export function TimeField(props: Props) {
  const [{ generation, refocus }, setField] = useState({ generation: 0, refocus: false });
  return <Field key={generation} {...props} refocus={refocus} onDiscard={(keepFocus) => setField({ generation: generation + 1, refocus: keepFocus })} />;
}

function Field({
  value,
  date,
  hour12,
  anchorAt,
  label,
  onCommit,
  onFocusChange,
  errorId,
  refocus,
  onDiscard,
}: Props & { refocus: boolean; onDiscard: (keepFocus: boolean) => void }) {
  const { locale } = useLocale();
  const ref = useRef<HTMLDivElement>(null);
  // Once the user has set the period themselves the guess keeps its hands off, until the row is
  // cleared (×, another device): what is typed next is a new entry. Resetting on a save would
  // not hold: the Enter or Tab that leaves a saved time lands on the period segment.
  const periodTouched = useRef(false);
  useEffect(() => {
    if (value == null) periodTouched.current = false;
  }, [value]);
  // A fresh Time per render would read as a new value and wipe the draft on each re-render.
  const time = useMemo(() => msToTime(value), [value]);
  const fieldProps = {
    'aria-label': `${label} time`,
    // React Aria puts both on every segment, which is what a screen reader lands on.
    'aria-describedby': errorId,
    isInvalid: errorId != null,
    value: time,
    onChange: (t: Time | null) => {
      if (t) onCommit(timeToMs(t, date));
    },
    hourCycle: hour12 ? (12 as const) : (24 as const),
    granularity: 'minute' as const,
    shouldForceLeadingZeros: true,
  };
  const state = useTimeFieldState({ ...fieldProps, locale });
  const editable = state.segments.filter((s) => s.isEditable);
  const partial = editable.some((s) => !s.isPlaceholder) && editable.some((s) => s.isPlaceholder);
  const [focused, setFocused] = useState(false);
  const { fieldProps: groupProps } = useTimeField(
    {
      ...fieldProps,
      autoFocus: refocus,
      onFocusChange: setFocused,
      // React Aria calls this only when focus leaves the whole field, never on a move between
      // its segments. The stored value comes back, or the row stays empty.
      onBlur: () => {
        if (partial) onDiscard(false);
      },
      onKeyDown: (e) => {
        if (e.key === 'Escape') onDiscard(true);
        else if (e.key === 'Enter') (e.target as HTMLElement).blur();
      },
    },
    state,
    ref,
  );
  // The cleanup also reports a field removed with focus inside, which Chrome and Firefox don't
  // announce with a blur: the card unmounting, its pair removed, and Escape's remount.
  useEffect(() => {
    if (!focused || !onFocusChange) return;
    onFocusChange(true);
    return () => onFocusChange(false);
  }, [focused, onFocusChange]);

  // React Stately fills the period from its placeholder (AM) as soon as an hour is typed.
  // Replace that with the guess while the hour of a new entry is still being typed: once the
  // minute is in, the value is complete and saved, and a change to the hour (or a minute cleared
  // to retype it) then is a deliberate edit that keeps the stored period. A
  // layout effect so the correction lands in the same commit, before the next keystroke can
  // build on the uncorrected state.
  const hourSeg = state.segments.find((s) => s.type === 'hour');
  const hourValue = hourSeg && !hourSeg.isPlaceholder ? (hourSeg.value ?? null) : null;
  const minuteEmpty = state.segments.find((s) => s.type === 'minute')?.isPlaceholder !== false;
  // `state` is a new object every render; the effect only has to run when the hour changes.
  const latest = useLatest(state);
  useLayoutEffect(() => {
    if (!hour12 || value != null || hourValue == null || !minuteEmpty || periodTouched.current) return;
    const wanted = guessPeriod(hourValue, date, anchorAt) === 'AM' ? 0 : 1;
    const period = latest.current.segments.find((s) => s.type === 'dayPeriod');
    if (period && period.value !== wanted) latest.current.setSegment('dayPeriod', wanted);
  }, [hour12, value, hourValue, minuteEmpty, date, anchorAt, latest]);

  return (
    <div {...groupProps} ref={ref} className={`input timefield${partial ? ' is-partial' : ''}`}>
      {state.segments.map((segment, i) => (
        <Segment key={i} segment={segment} state={state} onTouch={segment.type === 'dayPeriod' ? () => (periodTouched.current = true) : undefined} />
      ))}
    </div>
  );
}

function Segment({ segment, state, onTouch }: { segment: DateSegment; state: DateFieldState; onTouch?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const { segmentProps } = useDateSegment(segment, state, ref);
  return (
    <div {...segmentProps} ref={ref} className={`timefield-seg timefield-seg--${segment.type}`} onKeyDownCapture={onTouch} onPointerDownCapture={onTouch}>
      {segment.text}
    </div>
  );
}
