// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DurationField } from './DurationField';

afterEach(cleanup);

function renderField(minutes = 480, onCommit = vi.fn()) {
  const view = render(<DurationField label="Work day" minutes={minutes} min={1} max={24 * 60} onCommit={onCommit} />);
  return {
    ...view,
    onCommit,
    hours: screen.getByLabelText('Work day hours') as HTMLInputElement,
    mins: screen.getByLabelText('Work day minutes') as HTMLInputElement,
  };
}

describe('DurationField', () => {
  it('shows the minutes as hours and minutes, and saves only when the field is left', () => {
    const { hours, mins, onCommit } = renderField(510);
    expect([hours.value, mins.value]).toEqual(['8', '30']);
    fireEvent.change(hours, { target: { value: '9' } });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.blur(hours);
    expect(onCommit).toHaveBeenCalledWith(570);
  });

  it('does not save the hours on the way to the minutes', () => {
    // 5h 0m → 4h 30m must not store 4h 0m in between: late in a lunch window that moves the
    // deadline into the past and fires the alarm.
    const { hours, mins, onCommit } = renderField(300);
    fireEvent.change(hours, { target: { value: '4' } });
    fireEvent.blur(hours, { relatedTarget: mins });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.change(mins, { target: { value: '30' } });
    fireEvent.blur(mins, { relatedTarget: hours });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.blur(hours);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(270);
  });

  it('saves on Enter', () => {
    const { mins, onCommit } = renderField();
    mins.focus();
    fireEvent.change(mins, { target: { value: '15' } });
    fireEvent.keyDown(mins, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith(495);
  });

  it('keeps the total inside its bounds and whole', () => {
    const { hours, onCommit } = renderField();
    fireEvent.change(hours, { target: { value: '30' } });
    fireEvent.blur(hours);
    expect(onCommit).toHaveBeenLastCalledWith(24 * 60);
    fireEvent.change(hours, { target: { value: '7.33' } });
    fireEvent.blur(hours);
    expect(onCommit).toHaveBeenLastCalledWith(440);
  });

  it('puts the stored value back for a blank or non-numeric box', () => {
    // A cleared Work day used to save as 0, clamped to 1 minute, and rang the clock-out alarm.
    const { hours, mins, onCommit } = renderField();
    fireEvent.change(hours, { target: { value: '' } });
    fireEvent.blur(hours);
    expect([hours.value, mins.value]).toEqual(['8', '0']);

    fireEvent.change(hours, { target: { value: '' } });
    fireEvent.change(mins, { target: { value: 'x' } });
    fireEvent.blur(mins);
    expect([hours.value, mins.value]).toEqual(['8', '0']);

    fireEvent.change(hours, { target: { value: '' } });
    fireEvent.change(mins, { target: { value: '' } });
    fireEvent.blur(mins);
    expect([hours.value, mins.value]).toEqual(['8', '0']);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('saves a typed zero', () => {
    const onCommit = vi.fn();
    render(<DurationField label="Work day" minutes={60} min={0} max={24 * 60} onCommit={onCommit} />);
    const hours = screen.getByLabelText('Work day hours');
    fireEvent.change(hours, { target: { value: '0' } });
    fireEvent.blur(hours);
    expect(onCommit).toHaveBeenCalledWith(0);
  });

  it('puts the stored value back when a draft adds up to it, and takes a new value from outside', () => {
    const { hours, mins, onCommit, rerender } = renderField();
    fireEvent.change(hours, { target: { value: '7' } });
    fireEvent.change(mins, { target: { value: '60' } });
    fireEvent.blur(mins);
    expect(onCommit).not.toHaveBeenCalled();
    expect([hours.value, mins.value]).toEqual(['8', '0']);

    fireEvent.change(hours, { target: { value: '5' } });
    rerender(<DurationField label="Work day" minutes={600} min={1} max={24 * 60} onCommit={onCommit} />);
    expect([hours.value, mins.value]).toEqual(['10', '0']);
  });
});
