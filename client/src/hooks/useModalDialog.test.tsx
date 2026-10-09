// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useModalDialog } from './useModalDialog';

function Dialog({ onClose }: { onClose: () => void }) {
  const dialog = useModalDialog(onClose);
  return (
    <dialog aria-label="Example" {...dialog}>
      <p>Inside</p>
    </dialog>
  );
}

it('opens as a modal with focus on itself, and locks the page scroll until unmounted', () => {
  const { unmount } = render(<Dialog onClose={vi.fn()} />);
  const dialog = screen.getByRole('dialog', { hidden: true }) as HTMLDialogElement;
  expect(dialog.open).toBe(true);
  expect(document.activeElement).toBe(dialog);
  expect(document.body.classList.contains('no-scroll')).toBe(true);
  unmount();
  expect(dialog.open).toBe(false);
  expect(document.body.classList.contains('no-scroll')).toBe(false);
});

it('closes on the browser cancel gesture, on Escape outside an input method, and on a press on the backdrop only', () => {
  const onClose = vi.fn();
  render(<Dialog onClose={onClose} />);
  const dialog = screen.getByRole('dialog', { hidden: true });

  const cancel = new Event('cancel', { cancelable: true });
  fireEvent(dialog, cancel);
  expect(cancel.defaultPrevented).toBe(true);
  expect(onClose).toHaveBeenCalledTimes(1);

  fireEvent.keyDown(dialog, { key: 'Escape' });
  fireEvent.keyDown(dialog, { key: 'Enter' });
  fireEvent.keyDown(dialog, { key: 'Escape', isComposing: true });
  expect(onClose).toHaveBeenCalledTimes(2);

  fireEvent.mouseDown(screen.getByText('Inside'));
  expect(onClose).toHaveBeenCalledTimes(2);
  fireEvent.mouseDown(dialog);
  expect(onClose).toHaveBeenCalledTimes(3);
});

// The browser puts focus back on the opener only when close() finds the dialog still in the page
// and modal; happy-dom doesn't move focus, so the test checks that close() comes in time.
it('closes the dialog while it is still in the page, so the browser returns focus to the opener', () => {
  const connected: boolean[] = [];
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) {
    connected.push(this.isConnected);
  });
  const { unmount } = render(<Dialog onClose={vi.fn()} />);
  unmount();
  expect(connected).toEqual([true]);
});
