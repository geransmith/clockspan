// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { alert, dismissBanner, getBanners, type BannerAction } from '../lib/alerts';
import { BANNERS_MORE } from '../lib/copy';
import { SettingsProvider } from '../hooks/useSettings';
import { makeSettings, settle, T0 } from '../test/hooks';
import { Banners } from './Banners';

vi.mock('../api');

/** A sticky alert, like an alarm's: it stays until it is closed. */
function raise(title: string, action?: BannerAction) {
  alert({ title, tone: 'warn', tag: `test:${title}`, sticky: true, sound: false, notifications: false, action });
}

async function renderBanners() {
  render(<Banners />, { wrapper: SettingsProvider });
  await settle();
}

/** The banner whose title is `title`, to reach its buttons. */
const banner = (title: string) => within(screen.getByText(title).closest<HTMLElement>('.banner')!);

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  vi.mocked(api.getSettings).mockResolvedValue(makeSettings());
});
afterEach(() => {
  cleanup();
  // The banner list is module state, so each test starts with none.
  for (const b of getBanners()) dismissBanner(b.id);
});

describe('Banners', () => {
  const titles = ['Lunch', 'Second meal', 'Clock out', 'Retrospective'];

  it('draws the newest three and counts the one left out', async () => {
    for (const title of titles) raise(title);
    await renderBanners();
    expect(screen.queryByText('Lunch')).toBeNull();
    for (const title of titles.slice(1)) expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByText(BANNERS_MORE(1))).toBeTruthy();
  });

  it('brings the oldest back when one is closed, with no count left', async () => {
    for (const title of titles) raise(title);
    await renderBanners();
    fireEvent.click(banner('Clock out').getByRole('button', { name: 'Dismiss: Clock out' }));
    expect(screen.queryByText('Clock out')).toBeNull();
    for (const title of ['Lunch', 'Second meal', 'Retrospective']) expect(screen.getByText(title)).toBeTruthy();
    expect(screen.queryByText(BANNERS_MORE(1))).toBeNull();
  });

  it("hands the focus to the next banner's close when one is closed, else to the one before", async () => {
    for (const title of ['Lunch', 'Clock out', 'Retrospective']) raise(title);
    await renderBanners();
    const close = (title: string) => banner(title).getByRole('button', { name: `Dismiss: ${title}` });
    close('Clock out').focus();
    fireEvent.click(close('Clock out'));
    expect(document.activeElement).toBe(close('Retrospective'));
    fireEvent.click(close('Retrospective'));
    expect(document.activeElement).toBe(close('Lunch'));
  });

  it("runs a banner's action once and closes that banner, the focus going on unless the action moved it", async () => {
    const run = vi.fn();
    raise('Clock out', { label: 'Overtime approved', run });
    raise('Retrospective');
    await renderBanners();
    const approve = banner('Clock out').getByRole('button', { name: 'Overtime approved' });
    approve.focus();
    fireEvent.click(approve);
    expect(run).toHaveBeenCalledOnce();
    expect(screen.queryByText('Clock out')).toBeNull();
    expect(screen.getByText('Retrospective')).toBeTruthy();
    expect(document.activeElement).toBe(banner('Retrospective').getByRole('button', { name: 'Dismiss: Retrospective' }));

    // Like Open retrospective, which takes the focus to the note box.
    const note = document.body.appendChild(document.createElement('textarea'));
    raise('Review the day', { label: 'Open', run: () => note.focus() });
    await settle();
    const open = banner('Review the day').getByRole('button', { name: 'Open' });
    open.focus();
    fireEvent.click(open);
    expect(document.activeElement).toBe(note);
    note.remove();
  });
});
