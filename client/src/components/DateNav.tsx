import { useRef } from 'react';
import { useSettings } from '../hooks/useSettings';
import type { Route } from '../hooks/useRoute';
import { addDays } from '../../../shared/dates.js';
import { dayName, formatDateLong } from '../lib/format';
import { ChevronLeft, ChevronRight, Layout } from './Icons';

interface Props {
  /** The date on screen (today when the route holds none). */
  date: string;
  today: string;
  customize: boolean;
  onNavigate: (next: Partial<Route>, opts?: { replace?: boolean }) => void;
  onToggleCustomize: () => void;
}

/** The sheet's own row: the day on screen, the steps to its neighbours, and Customize. */
export function DateNav({ date, today, customize, onNavigate, onToggleCustomize }: Props) {
  const { loaded } = useSettings();
  // Typing a date fires a change with a whole date per digit (a year goes 0002, 0020, 0202, 2026),
  // so only the first change in a visit to the field adds a history entry and the rest replace it.
  const typed = useRef(false);
  // Next day on reaching today is disabled and Today goes once pressed, so either hands the focus
  // to Previous day rather than letting it fall back to the top of the page.
  const prevDay = useRef<HTMLButtonElement>(null);
  const isToday = date === today;
  // "Yesterday" gets the date underneath; any other day's name already is the date (the sheet never shows a future day).
  const name = dayName(date, today);
  const long = formatDateLong(date);

  return (
    <div className="datenav">
      <button ref={prevDay} className="btn btn-icon" onClick={() => onNavigate({ date: addDays(date, -1) })} aria-label="Previous day">
        <ChevronLeft />
      </button>
      <label className="datenav-label">
        <span className="datenav-text">{name}</span>
        {!isToday && name !== long && <span className="datenav-sub">{long}</span>}
        <input
          className="datenav-input"
          type="date"
          value={date}
          max={today}
          onFocus={() => {
            typed.current = false;
          }}
          onChange={(e) => {
            const v = e.target.value;
            // A year below 1000 is a part-typed one, and shared/dates can't read it.
            if (v < '1000') return;
            // A change that leaves the sheet where it is (a future date shows today) adds nothing, so it
            // mustn't turn on replace: the next change would overwrite the entry the user came from.
            if ((v >= today ? today : v) === date) return;
            onNavigate({ date: v }, { replace: typed.current });
            typed.current = true;
          }}
          onClick={(e) => {
            // A click starts a new choice: after a pick, desktop Chromium leaves focus here, so onFocus doesn't run again.
            typed.current = false;
            // The input is invisible over the label, and desktop Chromium opens its picker only from
            // the calendar icon at the input's right end, so a click anywhere on the label asks for it.
            try {
              e.currentTarget.showPicker();
            } catch {
              // No showPicker (an older browser): the click still focuses the field.
            }
          }}
          aria-label="Pick a date"
        />
      </label>
      <button
        className="btn btn-icon"
        onClick={() => {
          const next = addDays(date, 1);
          onNavigate({ date: next });
          if (next >= today) prevDay.current?.focus();
        }}
        aria-label="Next day"
        disabled={date >= today}
      >
        <ChevronRight />
      </button>
      {!isToday && (
        <button
          className="btn btn-ghost"
          onClick={() => {
            onNavigate({ date: null });
            prevDay.current?.focus();
          }}
        >
          Today
        </button>
      )}
      {/* Until the settings answer, the layout shown is the default one, and a change would save it whole over the user's. */}
      <button className="btn btn-icon datenav-customize" onClick={onToggleCustomize} disabled={!loaded} aria-pressed={customize} title="Customize layout">
        <Layout />
        <span className="btn-text">Customize</span>
      </button>
    </div>
  );
}
