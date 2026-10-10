// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { MINUTE_MS } from '../../../shared/dates.js';
import { unlockAudio } from '../lib/alerts';
import type { ShortcutId } from '../lib/shortcuts';
import { answered, deferredAnswer, makeSettings, pressKey, settle, ShortcutKeys, T0 } from '../test/hooks';
import type { Settings } from '../types';
import { SettingsProvider } from './useSettings';
import { useShortcut } from './useShortcuts';

vi.mock('../api');
vi.mock('../lib/alerts');

type Binding = { id: ShortcutId; run: (() => void) | null; name: string };

/** A button bound to a key, named `name`, as a card binds one beside its button. */
function Bound({ id, run, name }: Binding) {
  const keys = useShortcut(id, run);
  return <button aria-keyshortcuts={keys}>{name}</button>;
}

/** The listener and the bindings, in mount order; `again` renders them anew (the same names keep their place). */
async function renderKeys(bindings: Binding[]) {
  const page = (list: Binding[]) => (
    <SettingsProvider>
      <ShortcutKeys />
      {list.map((b) => (
        <Bound key={b.name} {...b} />
      ))}
    </SettingsProvider>
  );
  const view = render(page(bindings));
  await settle();
  return { again: (list: Binding[]) => view.rerender(page(list)) };
}

const keysOf = (name: string) => screen.getByRole('button', { name }).getAttribute('aria-keyshortcuts');

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  vi.mocked(api.getSettings).mockResolvedValue(answered(makeSettings()));
});

describe('useShortcut', () => {
  it('runs the newest binding inside the keydown and keeps the letter from being typed', async () => {
    const older = vi.fn();
    const newer = vi.fn();
    const { again } = await renderKeys([{ id: 'sheet', run: older, name: 'Older' }]);
    again([
      { id: 'sheet', run: older, name: 'Older' },
      { id: 'sheet', run: newer, name: 'Newer' },
    ]);
    expect(pressKey('s')).toBe(false);
    expect(newer).toHaveBeenCalledOnce();
    expect(older).not.toHaveBeenCalled();
  });

  it('falls back to the earlier binding when the newest unmounts, and leaves an unbound key alone', async () => {
    const older = vi.fn();
    const newer = vi.fn();
    const { again } = await renderKeys([
      { id: 'sheet', run: older, name: 'Older' },
      { id: 'sheet', run: newer, name: 'Newer' },
    ]);
    again([{ id: 'sheet', run: older, name: 'Older' }]);
    pressKey('S');
    expect(older).toHaveBeenCalledOnce();
    expect(newer).not.toHaveBeenCalled();
    // H is in the list, but nothing binds it here: the browser keeps it.
    expect(pressKey('h')).toBe(true);
  });

  it('binds only while run is given, keeping its place, and calls the latest render', async () => {
    const older = vi.fn();
    const first = vi.fn();
    const latest = vi.fn();
    const { again } = await renderKeys([
      { id: 'pause', run: older, name: 'Older' },
      { id: 'pause', run: null, name: 'Newer' },
    ]);
    expect(keysOf('Newer')).toBeNull();
    pressKey('p');
    expect(older).toHaveBeenCalledOnce();
    // Older goes off and comes back while Newer binds: Newer is still the newer one.
    again([
      { id: 'pause', run: null, name: 'Older' },
      { id: 'pause', run: first, name: 'Newer' },
    ]);
    // Only Older's run changes, as a card re-rendering alone passes a new one.
    again([
      { id: 'pause', run: older, name: 'Older' },
      { id: 'pause', run: first, name: 'Newer' },
    ]);
    pressKey('p');
    expect(first).toHaveBeenCalledOnce();
    again([
      { id: 'pause', run: older, name: 'Older' },
      { id: 'pause', run: latest, name: 'Newer' },
    ]);
    pressKey('p');
    expect(latest).toHaveBeenCalledOnce();
    expect(older).toHaveBeenCalledOnce();
    again([{ id: 'pause', run: null, name: 'Older' }]);
    expect(pressKey('p')).toBe(true);
  });

  it('unlocks audio inside the keydown for a timer key, not for a page key', async () => {
    const run = vi.fn(() => expect(unlockAudio).toHaveBeenCalledOnce());
    await renderKeys([
      { id: 'more', run, name: 'Add' },
      { id: 'history', run: vi.fn(), name: 'History' },
    ]);
    pressKey('h');
    expect(unlockAudio).not.toHaveBeenCalled();
    pressKey('+');
    expect(run).toHaveBeenCalledOnce();
  });

  it('names the key for aria-keyshortcuts while it is bound and shortcuts are on, Plus for +', async () => {
    await renderKeys([
      { id: 'new', run: vi.fn(), name: 'Add priority' },
      { id: 'more', run: vi.fn(), name: 'Add 5 minutes' },
    ]);
    expect(keysOf('Add priority')).toBe('N');
    expect(keysOf('Add 5 minutes')).toBe('Plus');
  });
});

describe('useShortcutListener', () => {
  it('listens only once the settings have loaded and while shortcuts are on', async () => {
    const answer = deferredAnswer<Settings>();
    vi.mocked(api.getSettings).mockReturnValue(answer.promise);
    const run = vi.fn();
    await renderKeys([{ id: 'history', run, name: 'History' }]);
    expect(keysOf('History')).toBeNull();
    expect(pressKey('h')).toBe(true);
    answer.resolve(makeSettings());
    await settle();
    expect(keysOf('History')).toBe('H');
    pressKey('h');
    expect(run).toHaveBeenCalledOnce();

    // Turned off on another device: the next read of the settings brings it.
    vi.mocked(api.getSettings).mockResolvedValue(answered(makeSettings({ shortcuts: false })));
    await settle(MINUTE_MS);
    expect(keysOf('History')).toBeNull();
    expect(pressKey('h')).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });
});
