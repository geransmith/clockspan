import type { KeyboardEvent } from 'react';
import { useAuth } from '../../auth/AuthGate';
import { useLastTab } from '../../hooks/useLastTab';
import { useModalDialog } from '../../hooks/useModalDialog';
import { useSaveStatus, type SaveState } from '../../hooks/useSaveStatus';
import { useSettings } from '../../hooks/useSettings';
import { RESET_SETTINGS, SAVE_STATUS } from '../../lib/copy';
import type { Settings } from '../../types';
import { Check, X } from '../Icons';
import { AccountTab } from './AccountTab';
import { AlarmsTab } from './AlarmsTab';
import { DataTab } from './DataTab';
import { SheetTab } from './SheetTab';
import { TimeclockTab } from './TimeclockTab';

type TabId = 'timeclock' | 'alarms' | 'sheet' | 'data' | 'account';
const TABS: { id: TabId; label: string }[] = [
  { id: 'timeclock', label: 'Timeclock' },
  { id: 'alarms', label: 'Alarms' },
  { id: 'sheet', label: 'Sheet' },
  { id: 'data', label: 'Data' },
  { id: 'account', label: 'Account' },
];
const TAB_STORAGE_KEY = 'focus:settingsTab';

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { settings, update, reset } = useSettings();
  const { auth } = useAuth();
  const { saveState, save } = useSaveStatus();
  // Account holds password + users, which only exist with local accounts.
  const tabs = TABS.filter((t) => t.id !== 'account' || auth.mode === 'local');
  const [tab, setTab] = useLastTab(TAB_STORAGE_KEY, tabs, 'timeclock');

  // Focus lands on the dialog, not on the Close button, where Enter would shut what was just opened.
  const dialog = useModalDialog(onClose);

  const set = (patch: Partial<Settings>) => void save(() => update(patch));
  const onReset = () => {
    if (window.confirm(RESET_SETTINGS.confirm)) void save(reset);
  };

  // The ARIA tabs pattern: Left/Right move between the tabs (roving tabindex), so the handler
  // sits on each tab, the element that has focus.
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const i = tabs.findIndex((t) => t.id === tab);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    if (!next) return;
    setTab(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  };

  const panel = () => {
    switch (tab) {
      case 'timeclock':
        return <TimeclockTab settings={settings} set={set} />;
      case 'alarms':
        return <AlarmsTab settings={settings} set={set} />;
      case 'sheet':
        return <SheetTab settings={settings} set={set} />;
      case 'data':
        return <DataTab settings={settings} set={set} onReset={onReset} />;
      case 'account':
        return <AccountTab user={auth.user} />;
    }
  };

  return (
    <dialog {...dialog} className="dialog" aria-labelledby="settings-title">
      <div className="dialog-inner">
        <header className="dialog-head">
          <h2 id="settings-title">Settings</h2>
          <SaveStatus state={saveState} />
          <button className="btn btn-icon" onClick={onClose} aria-label="Close settings">
            <X />
          </button>
        </header>
        <div className="tabs" role="tablist" aria-label="Settings sections">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              className={`tab${tab === t.id ? ' is-active' : ''}`}
              onClick={() => setTab(t.id)}
              onKeyDown={onTabKey}
            >
              {t.label}
            </button>
          ))}
        </div>
        {/* Keyed so switching tabs starts each panel at the top instead of mid-scroll. */}
        <div key={tab} className="dialog-body" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
          {saveState === 'failed' && <p className="notice notice--danger">{SAVE_STATUS.failedDetail}</p>}
          {panel()}
        </div>
      </div>
    </dialog>
  );
}

/** Always rendered, empty when idle: a live region has to exist before its text changes to be announced. */
function SaveStatus({ state }: { state: SaveState }) {
  const pill = state === 'saved' ? ' pill pill--ok' : state === 'failed' ? ' pill pill--danger' : state === 'saving' ? ' pill' : '';
  return (
    <span className={`save-status${pill}`} role="status" aria-live="polite">
      {state === 'saving' && SAVE_STATUS.saving}
      {state === 'saved' && (
        <>
          <Check />
          {SAVE_STATUS.saved}
        </>
      )}
      {state === 'failed' && SAVE_STATUS.failed}
    </span>
  );
}
