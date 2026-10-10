import { Fragment, useId, useState } from 'react';
import { useModalDialog } from '../hooks/useModalDialog';
import { useSettings } from '../hooks/useSettings';
import { useShortcut, useShortcutListener } from '../hooks/useShortcuts';
import { SHORTCUTS, type ShortcutGroup, type ShortcutId } from '../lib/shortcuts';
import { X } from './Icons';

const GROUPS: Record<ShortcutGroup, string> = { add: 'Add', pages: 'Pages', timer: 'Timer' };

/**
 * The keys' one listener, and ? for their list. Mounted once in App; every other key is bound
 * beside its button. Not a lazy chunk: the list is short, and its data is in the first load.
 */
export function Shortcuts() {
  useShortcutListener();
  const [open, setOpen] = useState(false);
  useShortcut('help', () => setOpen(true));
  return open ? <Help onClose={() => setOpen(false)} /> : null;
}

function Help({ onClose }: { onClose: () => void }) {
  const dialog = useModalDialog(onClose);
  const titleId = useId();
  const { settings } = useSettings();
  const labels: Record<ShortcutId, string> = {
    new: 'New priority on the sheet, new card in Later on the board',
    sheet: "Today's sheet",
    board: 'Board, or back to the sheet',
    history: 'History, or back to the sheet',
    help: 'This list',
    pause: 'Pause or resume',
    finish: "Finish, once time's up",
    more: `Add ${settings.adjustStepMinutes} minutes`,
    rest: 'Start a break from the timer card',
  };
  const ids = Object.keys(SHORTCUTS) as ShortcutId[];
  return (
    <dialog {...dialog} className="dialog shortcuts-help" aria-labelledby={titleId}>
      <div className="dialog-inner">
        <header className="dialog-head">
          <h2 id={titleId}>Keyboard shortcuts</h2>
          <button className="btn btn-icon" onClick={onClose} aria-label="Close shortcuts">
            <X />
          </button>
        </header>
        <div className="dialog-body">
          {(Object.keys(GROUPS) as ShortcutGroup[]).map((group) => (
            <section key={group} className="settings-section">
              <h3>{GROUPS[group]}</h3>
              <dl className="shortcut-list">
                {ids
                  .filter((id) => SHORTCUTS[id].group === group)
                  .map((id) => (
                    <Fragment key={id}>
                      <dt>
                        <kbd>{SHORTCUTS[id].key}</kbd>
                      </dt>
                      <dd>{labels[id]}</dd>
                    </Fragment>
                  ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </dialog>
  );
}
