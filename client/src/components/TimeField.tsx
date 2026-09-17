import { useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { mergeProps, useDateSegment, useLocale, useTimeField } from 'react-aria';
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
}

/**
 * Hour / minute / AM-PM segments on React Aria: typing advances, ↑/↓ step, `a`/`p` set the
 * period. The value saves the moment every segment is filled, and a half-typed draft is
 * thrown away when focus leaves the field, so the row never shows a time it hasn't stored.
 * Remounting is how the draft is discarded.
 */
export function TimeField(props: Props) {
  const [generation, setGeneration] = useState(0);
  return <Field key={generation} {...props} onDiscard={() => setGeneration((g) => g + 1)} />;
}

function Field({ value, date, hour12, anchorAt, label, onCommit, onDiscard }: Props & { onDiscard: () => void }) {
  const { locale } = useLocale();
  const ref = useRef<HTMLDivElement>(null);
  // Once the user has set the period themselves the guess keeps its hands off.
  const periodTouched = useRef(false);
  // A fresh Time per render would read as a new value and wipe the draft every second.
  const time = useMemo(() => msToTime(value), [value]);
  const fieldProps = {
    'aria-label': `${label} time`,
    value: time,
    onChange: (t: Time | null) => {
      if (t) onCommit(timeToMs(t, date));
    },
    hourCycle: hour12 ? (12 as const) : (24 as const),
    granularity: 'minute' as const,
    shouldForceLeadingZeros: true,
  };
  const state = useTimeFieldState({ ...fieldProps, locale });
  const { fieldProps: groupProps } = useTimeField(fieldProps, state, ref);

  // React Stately fills the period from its placeholder (AM) as soon as an hour is typed.
  // Replace that with the guess while the hour is still being typed: once the minute is in,
  // the value is complete and saved, and a change to the hour then is a deliberate edit. A
  // layout effect so the correction lands in the same commit, before the next keystroke can
  // build on the uncorrected state.
  const hourSeg = state.segments.find((s) => s.type === 'hour');
  const hourValue = hourSeg && !hourSeg.isPlaceholder ? (hourSeg.value ?? null) : null;
  const minuteEmpty = state.segments.find((s) => s.type === 'minute')?.isPlaceholder !== false;
  // `state` is a new object every render; the effect only has to run when the hour changes.
  const latest = useLatest(state);
  useLayoutEffect(() => {
    if (!hour12 || hourValue == null || !minuteEmpty || periodTouched.current) return;
    const wanted = guessPeriod(hourValue, 0, date, anchorAt) === 'AM' ? 0 : 1;
    const period = latest.current.segments.find((s) => s.type === 'dayPeriod');
    if (period && period.value !== wanted) latest.current.setSegment('dayPeriod', wanted);
  }, [hour12, hourValue, minuteEmpty, date, anchorAt, latest]);

  const editable = state.segments.filter((s) => s.isEditable);
  const filled = editable.some((s) => !s.isPlaceholder);
  const partial = filled && editable.some((s) => s.isPlaceholder);

  // Leaving the field with a half-typed time: the stored value comes back (or the row stays
  // empty). A blur to another segment of the same field is not leaving.
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    if (partial || (value != null && !filled)) onDiscard();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') onDiscard();
    else if (e.key === 'Enter') (e.target as HTMLElement).blur();
  };

  return (
    <div {...mergeProps(groupProps, { onBlur, onKeyDown })} ref={ref} className={`timefield${partial ? ' is-partial' : ''}`}>
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
    <div
      {...segmentProps}
      ref={ref}
      className={`timefield-seg timefield-seg--${segment.type}`}
      data-placeholder={segment.isPlaceholder || undefined}
      onKeyDownCapture={onTouch}
      onPointerDownCapture={onTouch}
    >
      {segment.text}
    </div>
  );
}
