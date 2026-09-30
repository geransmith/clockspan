// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NumberField } from './controls';

afterEach(cleanup);

function renderField() {
  const onCommit = vi.fn();
  render(<NumberField label="Keep the last" unit="days" value={365} min={30} max={3650} onCommit={onCommit} />);
  return { onCommit, input: screen.getByLabelText('Keep the last') as HTMLInputElement };
}

const typeAndLeave = (input: HTMLInputElement, value: string) => {
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
};

describe('NumberField', () => {
  it('puts the stored value back for a blank or non-numeric box', () => {
    // A cleared "Keep the last" used to save the minimum, 30 days, and the next cleanup deleted the rest.
    const { input, onCommit } = renderField();
    typeAndLeave(input, '');
    expect(input.value).toBe('365');
    typeAndLeave(input, '9o');
    expect(input.value).toBe('365');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('saves a whole number inside its bounds', () => {
    const { input, onCommit } = renderField();
    typeAndLeave(input, '45.6');
    expect(onCommit).toHaveBeenLastCalledWith(46);
    typeAndLeave(input, '10');
    expect(onCommit).toHaveBeenLastCalledWith(30);
    typeAndLeave(input, '5000');
    expect(onCommit).toHaveBeenLastCalledWith(3650);
  });

  it('saves on Enter', () => {
    const { input, onCommit } = renderField();
    // happy-dom sends no blur to an element that never had focus.
    input.focus();
    fireEvent.change(input, { target: { value: '60' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith(60);
  });
});
