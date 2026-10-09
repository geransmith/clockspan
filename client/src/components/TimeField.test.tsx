// @vitest-environment happy-dom
import { Time } from '@internationalized/date';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { timeToMs } from '../lib/timefield';
import { TODAY } from '../test/hooks';
import { TimeField } from './TimeField';

type FieldProps = Partial<ComponentProps<typeof TimeField>>;

function renderField(props: FieldProps = {}) {
  // The row shows the time it saved, as a punch row does.
  const onCommit = vi.fn((ms: number) => again({ value: ms }));
  const field = (p: FieldProps) => (
    <>
      <TimeField value={null} date={TODAY} hour12={false} anchorAt={null} label="Clock in" onCommit={onCommit} {...props} {...p} />
      <button>Elsewhere</button>
    </>
  );
  const view = render(field({}));
  const again = (p: FieldProps) => view.rerender(field(p));
  return { onCommit, again };
}

const at = (hour: number, minute: number) => timeToMs(new Time(hour, minute), TODAY);
const group = () => screen.getByRole('group', { name: 'Clock in time' });
const segment = (name: 'hour' | 'minute' | 'AM/PM') => screen.getByRole('spinbutton', { name: `${name}, Clock in time` });
const focus = (el: HTMLElement) => act(() => el.focus());
/** What a key typed into a segment sends: React Aria reads the text from `beforeinput`. */
const typeInto = (el: Element, data: string) =>
  act(() => {
    el.dispatchEvent(new InputEvent('beforeinput', { data, inputType: 'insertText', bubbles: true, cancelable: true }));
  });

describe('TimeField', () => {
  it('throws a half-typed time away when focus leaves the field, not when focus moves between its segments', () => {
    const { onCommit } = renderField();
    focus(segment('hour'));
    fireEvent.keyDown(segment('hour'), { key: 'ArrowUp' });
    expect(group().classList).toContain('is-partial');
    focus(segment('minute'));
    expect(group().classList).toContain('is-partial');
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    focus(elsewhere);
    expect(group().classList).not.toContain('is-partial');
    expect(segment('hour').hasAttribute('data-placeholder')).toBe(true);
    expect(document.activeElement).toBe(elsewhere);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('keeps focus in the field when Escape throws a draft away', () => {
    const onFocusChange = vi.fn<(focused: boolean) => void>();
    const { onCommit } = renderField({ onFocusChange });
    focus(segment('hour'));
    fireEvent.keyDown(segment('hour'), { key: 'ArrowUp' });
    expect(group().classList).toContain('is-partial');
    fireEvent.keyDown(segment('hour'), { key: 'Escape' });
    expect(document.activeElement).toBe(segment('hour'));
    expect(segment('hour').hasAttribute('data-placeholder')).toBe(true);
    expect(group().classList).not.toContain('is-partial');
    expect(onFocusChange).toHaveBeenLastCalledWith(true);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('guesses the period again on a row cleared after its period was touched', () => {
    // A later row at 12:30 PM, its period clicked; then × and 2:15, which reads as the afternoon.
    const { onCommit, again } = renderField({ hour12: true, value: at(12, 30), anchorAt: at(8, 30) });
    fireEvent.pointerDown(segment('AM/PM'));
    again({ value: null });
    focus(segment('hour'));
    for (const key of ['2', '1', '5']) typeInto(document.activeElement!, key);
    expect(onCommit).toHaveBeenLastCalledWith(at(14, 15));
  });

  it('keeps the stored period when the minute of a saved time is cleared and typed again', () => {
    // 8:05 PM after a 7:30 AM clock-in: a new 8 would read as the morning, but this one is saved.
    const { onCommit } = renderField({ hour12: true, value: at(20, 5), anchorAt: at(7, 30) });
    focus(segment('minute'));
    fireEvent.keyDown(segment('minute'), { key: 'Backspace' });
    expect(segment('minute').hasAttribute('data-placeholder')).toBe(true);
    for (const key of ['1', '0']) typeInto(segment('minute'), key);
    expect(onCommit).toHaveBeenLastCalledWith(at(20, 10));
  });

  it('keeps a period set by hand while the time is typed', () => {
    const { onCommit } = renderField({ hour12: true });
    focus(segment('AM/PM'));
    fireEvent.keyDown(segment('AM/PM'), { key: 'p' });
    typeInto(segment('AM/PM'), 'p');
    // The period is the last segment, so focus stays there.
    expect(document.activeElement).toBe(segment('AM/PM'));
    focus(segment('hour'));
    for (const key of ['8', '0', '0']) typeInto(document.activeElement!, key);
    expect(onCommit).toHaveBeenLastCalledWith(at(20, 0));
  });
});
