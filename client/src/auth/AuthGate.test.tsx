// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import * as api from '../api';
import { dismissByTag, getBanners } from '../lib/alerts';
import { HTTPS_ONLY, NEW_PASSWORD, PASSWORD_MISMATCH, SIGN_OUT_FAILED } from '../lib/copy';
import { AUTH_USER_KEY } from '../lib/storage';
import { setVisibility, settle } from '../test/hooks';
import type { AuthInfo, PublicUser } from '../types';
import { AuthGate, useAuth } from './AuthGate';

vi.mock('../api', async (importOriginal) => {
  // The event name has to stay the real one: the gate listens for what `request()` dispatches.
  const { UNAUTHENTICATED_EVENT } = await importOriginal<typeof import('../api')>();
  return { UNAUTHENTICATED_EVENT, getAuth: vi.fn(), logout: vi.fn(), changePassword: vi.fn() };
});

const USER: PublicUser = { id: 2, name: 'sam', username: 'sam', isAdmin: false, kind: 'local', mustChangePassword: false };
const TEMPORARY: PublicUser = { ...USER, mustChangePassword: true };
const info = (patch: Partial<AuthInfo>): AuthInfo => ({ mode: 'local', setupRequired: false, user: null, cookieSecure: false, ...patch });

/** What the app's sign-out resolved with. */
const signedOut = vi.fn();

function App() {
  const { auth, signOut } = useAuth();
  return (
    <>
      <p>Sheet for {auth.user?.name ?? 'you'}</p>
      <button onClick={() => void signOut().then(signedOut)}>Sign out</button>
    </>
  );
}

async function renderGate(answer: AuthInfo) {
  vi.mocked(api.getAuth).mockResolvedValue(answer);
  render(
    <AuthGate>
      <App />
    </AuthGate>,
  );
  await settle();
}

/** happy-dom's own hook for the page address; the https hint depends on the protocol. */
function setUrl(url: string): void {
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(url);
}

/** A request that found the session gone, the way `request()` announces it. */
async function lostSession(): Promise<void> {
  window.dispatchEvent(new Event(api.UNAUTHENTICATED_EVENT));
  await settle();
}

async function signOut(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  await settle();
}

/** Holds /me answers back until the returned function gives one. */
function holdAnswer(): (a: AuthInfo) => void {
  let give!: (a: AuthInfo) => void;
  vi.mocked(api.getAuth).mockReturnValue(new Promise((resolve) => (give = resolve)));
  return give;
}

/** Another tab of this browser signing someone in (an id) or out (''). */
function otherTabSignsIn(value: string): void {
  localStorage.setItem(AUTH_USER_KEY, value);
  window.dispatchEvent(new StorageEvent('storage', { key: AUTH_USER_KEY, newValue: value }));
}

const pageShow = (persisted: boolean) => window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted }));
const signOutBanners = () => getBanners().filter((b) => b.tag === 'sign-out-failed');

let reload: MockInstance<() => void>;
let assign: MockInstance<(url: string | URL) => void>;

beforeEach(() => {
  vi.useFakeTimers();
  setUrl('https://clockspan.example/');
  localStorage.clear();
  reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
  assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  dismissByTag('sign-out-failed');
  vi.useRealTimers();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe('AuthGate', () => {
  it('opens the app with no sign-in under AUTH_MODE=none, and for a signed-in user', async () => {
    await renderGate(info({ mode: 'none', user: { ...USER, id: 1, name: 'You', kind: 'default', username: null } }));
    expect(screen.getByText('Sheet for You')).toBeTruthy();
    cleanup();
    await renderGate(info({ user: USER }));
    expect(screen.getByText('Sheet for sam')).toBeTruthy();
    expect(localStorage.getItem(AUTH_USER_KEY)).toBe('2');
  });

  it('shows the setup page until the first account exists, then the sign-in page', async () => {
    await renderGate(info({ setupRequired: true }));
    expect(screen.getByPlaceholderText('XXXX-XXXX-XXXX')).toBeTruthy();
    cleanup();
    await renderGate(info({}));
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByPlaceholderText('XXXX-XXXX-XXXX')).toBeNull();
    expect(localStorage.getItem(AUTH_USER_KEY)).toBe('');
  });

  it('sends OIDC sign-ins to the provider', async () => {
    await renderGate(info({ mode: 'oidc' }));
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/auth/login');
  });

  it('asks for a new password before anything else on a temporary one', async () => {
    await renderGate(info({ user: TEMPORARY }));
    expect(screen.getByText(NEW_PASSWORD.title)).toBeTruthy();
    expect(screen.queryByText(/Sheet for/)).toBeNull();
  });

  const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
  const setPassword = () => fireEvent.submit(screen.getByRole('button', { name: 'Set password' }).closest('form')!);

  it('checks the new password was typed the same twice before sending it', async () => {
    await renderGate(info({ user: TEMPORARY }));
    type('Temporary password', 'temp-pass-1');
    type('New password', 'my own pass');
    type('Confirm new password', 'my own pas');
    setPassword();
    await settle();
    expect(screen.getByText(PASSWORD_MISMATCH)).toBeTruthy();
    expect(api.changePassword).not.toHaveBeenCalled();

    type('Confirm new password', 'my own pass');
    vi.mocked(api.changePassword).mockResolvedValue({ ok: true });
    vi.mocked(api.getAuth).mockResolvedValue(info({ user: USER }));
    setPassword();
    await settle();
    expect(api.changePassword).toHaveBeenCalledWith('temp-pass-1', 'my own pass');
    expect(screen.getByText('Sheet for sam')).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
  });

  it('offers a retry, not the form again, when the read after a saved new password fails', async () => {
    await renderGate(info({ user: TEMPORARY }));
    type('Temporary password', 'temp-pass-1');
    type('New password', 'my own pass');
    type('Confirm new password', 'my own pass');
    vi.mocked(api.changePassword).mockResolvedValue({ ok: true });
    vi.mocked(api.getAuth)
      .mockRejectedValueOnce(new Error('Request failed (502)'))
      .mockResolvedValue(info({ user: USER }));
    setPassword();
    await settle();
    expect(screen.getByText(/Request failed \(502\)/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set password' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(screen.getByText('Sheet for sam')).toBeTruthy();
    expect(api.changePassword).toHaveBeenCalledTimes(1);
  });

  it('warns over plain http when the session cookie is https-only', async () => {
    setUrl('http://clockspan.lan/');
    await renderGate(info({ cookieSecure: true }));
    expect(screen.getByText(HTTPS_ONLY.hint)).toBeTruthy();
    cleanup();
    await renderGate(info({ cookieSecure: false }));
    expect(screen.queryByText(HTTPS_ONLY.hint)).toBeNull();
  });

  it('offers a retry when the server does not answer', async () => {
    vi.mocked(api.getAuth).mockRejectedValueOnce(new Error('Request failed (502)'));
    await renderGate(info({ user: USER }));
    // renderGate's answer is queued behind the failure, so the first read fails.
    expect(screen.getByText(/Request failed \(502\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(screen.getByText('Sheet for sam')).toBeTruthy();
  });

  describe('once the app is open', () => {
    it('asks the server again when a request finds the session gone, and reloads the page when it is', async () => {
      await renderGate(info({ user: USER }));
      vi.mocked(api.getAuth).mockResolvedValue(info({}));
      await lostSession();
      expect(api.getAuth).toHaveBeenCalledTimes(2);
      expect(reload).toHaveBeenCalledTimes(1);
      // The page load takes the sheet away; the gate never swaps the sign-in page in over it.
      expect(screen.getByText('Sheet for sam')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();

      await lostSession();
      expect(api.getAuth).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['another user', info({ user: { ...USER, id: 3, name: 'alex' } })],
      ['the same user on a temporary password', info({ user: TEMPORARY })],
    ])('reloads once when /me names %s', async (_, answer) => {
      await renderGate(info({ user: USER }));
      vi.mocked(api.getAuth).mockResolvedValue(answer);
      window.dispatchEvent(new Event(api.UNAUTHENTICATED_EVENT));
      await lostSession();
      expect(api.getAuth).toHaveBeenCalledTimes(3);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(screen.getByText('Sheet for sam')).toBeTruthy();
      expect(localStorage.getItem(AUTH_USER_KEY)).toBe('2');
    });

    it('keeps the app when /me still names the same user, or does not answer', async () => {
      await renderGate(info({ user: USER }));
      await lostSession();
      vi.mocked(api.getAuth).mockRejectedValueOnce(new Error('Request failed (502)'));
      await lostSession();
      expect(api.getAuth).toHaveBeenCalledTimes(3);
      expect(reload).not.toHaveBeenCalled();
      expect(screen.getByText('Sheet for sam')).toBeTruthy();
    });
  });

  describe('sign-out', () => {
    it('goes to the start page, tells the other tabs, and asks nothing more', async () => {
      await renderGate(info({ user: USER }));
      vi.mocked(api.logout).mockResolvedValue({ ok: true });
      await signOut();
      expect(assign).toHaveBeenCalledWith('/');
      expect(localStorage.getItem(AUTH_USER_KEY)).toBe('');
      expect(signedOut).toHaveBeenCalledWith(true);

      // A write queued before the sign-out finds the session gone.
      await lostSession();
      expect(api.getAuth).toHaveBeenCalledTimes(1);
      expect(reload).not.toHaveBeenCalled();
    });

    it("follows the provider's end-session redirect under OIDC", async () => {
      await renderGate(info({ mode: 'oidc', user: { ...USER, kind: 'oidc', username: null } }));
      vi.mocked(api.logout).mockResolvedValue({ ok: true, redirect: 'https://idp.example/end' });
      await signOut();
      expect(assign).toHaveBeenCalledWith('https://idp.example/end');
      expect(localStorage.getItem(AUTH_USER_KEY)).toBe('');
    });

    it('records nothing from a /me answer that lands after it', async () => {
      await renderGate(info({ user: USER }));
      const answer = holdAnswer();
      await lostSession();
      vi.mocked(api.logout).mockResolvedValue({ ok: true });
      await signOut();
      answer(info({ user: USER }));
      await settle();
      expect(localStorage.getItem(AUTH_USER_KEY)).toBe('');
      expect(reload).not.toHaveBeenCalled();
    });

    it('says so and keeps the app when the logout is refused and /me still names the user', async () => {
      await renderGate(info({ user: USER }));
      vi.mocked(api.logout).mockRejectedValue(new Error('Request failed (502)'));
      await signOut();
      expect(screen.getByText('Sheet for sam')).toBeTruthy();
      expect(signOutBanners().map((b) => b.title)).toEqual([SIGN_OUT_FAILED]);
      expect(signedOut).toHaveBeenCalledWith(false);
      expect(api.getAuth).toHaveBeenCalledTimes(2);
      expect(assign).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
    });

    it('says so when the logout and the read after it both fail', async () => {
      await renderGate(info({ user: USER }));
      vi.mocked(api.logout).mockRejectedValue(new Error('Request failed (502)'));
      vi.mocked(api.getAuth).mockRejectedValue(new Error('Request failed (502)'));
      await signOut();
      expect(screen.getByText('Sheet for sam')).toBeTruthy();
      expect(signOutBanners()).toHaveLength(1);
      expect(signedOut).toHaveBeenCalledWith(false);
    });

    it('reloads when the logout got no answer but went through', async () => {
      await renderGate(info({ user: USER }));
      vi.mocked(api.logout).mockRejectedValue(new Error('The server did not answer in time.'));
      vi.mocked(api.getAuth).mockResolvedValue(info({}));
      await signOut();
      expect(reload).toHaveBeenCalledTimes(1);
      expect(signOutBanners()).toEqual([]);
      expect(signedOut).toHaveBeenCalledWith(true);
    });

    it('shows a refused logout on the new-password page, and the sign-in page for one that went through', async () => {
      await renderGate(info({ user: TEMPORARY }));
      vi.mocked(api.logout).mockRejectedValue(new Error('Request failed (502)'));
      await signOut();
      expect(screen.getByText(SIGN_OUT_FAILED)).toBeTruthy();
      expect(screen.getByText(NEW_PASSWORD.title)).toBeTruthy();
      expect(signOutBanners()).toEqual([]);

      vi.mocked(api.getAuth).mockResolvedValue(info({}));
      await signOut();
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
      expect(reload).not.toHaveBeenCalled();
    });
  });

  describe('other tabs', () => {
    it("goes by the stored user only once its own first answer has replaced the last page's", async () => {
      localStorage.setItem(AUTH_USER_KEY, '3');
      const answer = holdAnswer();
      render(
        <AuthGate>
          <App />
        </AuthGate>,
      );
      await settle();
      setVisibility('visible');
      answer(info({ user: USER }));
      await settle();
      setVisibility('visible');
      expect(reload).not.toHaveBeenCalled();
      expect(localStorage.getItem(AUTH_USER_KEY)).toBe('2');
    });

    it('reloads when another tab stores another user, and not for the same one or another key', async () => {
      await renderGate(info({ user: USER }));
      otherTabSignsIn('2');
      localStorage.setItem(AUTH_USER_KEY, '3');
      window.dispatchEvent(new StorageEvent('storage', { key: 'focus:theme', newValue: 'dark' }));
      expect(reload).not.toHaveBeenCalled();

      otherTabSignsIn('');
      otherTabSignsIn('4');
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['a page brought back from the bfcache', (persisted: boolean) => pageShow(persisted)],
      ['a tab shown again', (shown: boolean) => setVisibility(shown ? 'visible' : 'hidden')],
    ])('checks the stored user on %s', async (_, show) => {
      await renderGate(info({ user: USER }));
      show(true);
      localStorage.setItem(AUTH_USER_KEY, '');
      show(false);
      expect(reload).not.toHaveBeenCalled();
      show(true);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('reloads a page brought back from the bfcache after its own sign-out', async () => {
      await renderGate(info({ user: USER }));
      vi.mocked(api.logout).mockResolvedValue({ ok: true });
      await signOut();
      pageShow(true);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('leaves a gate page alone until another tab signs someone in', async () => {
      await renderGate(info({ user: TEMPORARY }));
      setVisibility('visible');
      expect(reload).not.toHaveBeenCalled();
      localStorage.setItem(AUTH_USER_KEY, '3');
      setVisibility('visible');
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('never reloads under AUTH_MODE=none', async () => {
      localStorage.setItem(AUTH_USER_KEY, '');
      await renderGate(info({ mode: 'none', user: { ...USER, id: 1, name: 'You', kind: 'default', username: null } }));
      setVisibility('visible');
      pageShow(true);
      expect(reload).not.toHaveBeenCalled();
    });
  });
});
