import { useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent, type SyntheticEvent } from 'react';

/**
 * A native modal `<dialog>`, opened on mount and closed on unmount. The browser traps focus
 * inside it, puts it in the top layer and turns Escape into a `cancel` event. Rendered closed,
 * then opened here, so nothing flashes. Focus lands on the dialog itself (its title is read
 * out; Tab reaches the controls) rather than on the first button showModal() would pick, where
 * Enter would act before the question was seen. The page behind still needs the scroll lock
 * on iOS. A layout effect, so the close on unmount runs while the dialog is still in the page,
 * modal, and the browser puts focus back where it was before the dialog opened; a passive
 * cleanup runs after React has removed the node, and focus would fall to the page.
 *
 * Spread the result on the `<dialog>`. It closes three ways: `cancel` (the browser's own
 * gestures: Escape, Android back); an Escape keydown, where a browser routes the key
 * differently (closing twice is harmless); and a press on the ::backdrop, which lands on the
 * dialog element itself while anything inside hits the inner surface.
 *
 * The caller renders the `<dialog>` from its first render until it unmounts, so its parent
 * decides whether it shows by mounting it: an early `return null` after this hook would throw
 * on mount (no dialog to open) or leave the scroll lock on.
 */
export function useModalDialog(onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    el.showModal();
    el.focus();
    document.body.classList.add('no-scroll');
    return () => {
      el.close();
      document.body.classList.remove('no-scroll');
    };
  }, []);
  return {
    ref,
    tabIndex: -1,
    onCancel: (e: SyntheticEvent<HTMLDialogElement>) => {
      e.preventDefault();
      onClose();
    },
    onKeyDown: (e: KeyboardEvent<HTMLDialogElement>) => {
      // An input method's Escape drops a candidate inside a field: it doesn't close the dialog.
      if (e.key === 'Escape' && !e.nativeEvent.isComposing) onClose();
    },
    onMouseDown: (e: MouseEvent<HTMLDialogElement>) => {
      if (e.target === e.currentTarget) onClose();
    },
  };
}
