// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { HTTPS_ONLY, NEW_PASSWORD } from '../lib/copy';
import { settle } from '../test/hooks';
import type { AuthInfo, PublicUser } from '../types';
import { AuthGate, useAuth } from './AuthGate';

vi.mock('../api', async (importOriginal) => {
  // The event name has to stay the real one: the gate listens for what `request()` dispatches.
  const { UNAUTHENTICATED_EVENT } = await importOriginal<typeof import('../api')>();
  return { UNAUTHENTICATED_EVENT, getAuth: vi.fn(), logout: vi.fn() };
});

const USER: PublicUser = { id: 2, name: 'sam', username: 'sam', isAdmin: false, kind: 'local', mustChangePassword: false };
const info = (patch: Partial<AuthInfo>): AuthInfo => ({ mode: 'local', setupRequired: false, user: null, cookieSecure: false, ...patch });

function App() {
  const { auth } = useAuth();
  return <p>Sheet for {auth.user?.name ?? 'you'}</p>;
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

beforeEach(() => {
  vi.useFakeTimers();
  setUrl('https://clockspan.example/');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('AuthGate', () => {
  it('opens the app with no sign-in under AUTH_MODE=none, and for a signed-in user', async () => {
    await renderGate(info({ mode: 'none', user: { ...USER, id: 1, name: 'You', kind: 'default', username: null } }));
    expect(screen.getByText('Sheet for You')).toBeTruthy();
    cleanup();
    await renderGate(info({ user: USER }));
    expect(screen.getByText('Sheet for sam')).toBeTruthy();
  });

  it('shows the setup page until the first account exists, then the sign-in page', async () => {
    await renderGate(info({ setupRequired: true }));
    expect(screen.getByPlaceholderText('XXXX-XXXX-XXXX')).toBeTruthy();
    cleanup();
    await renderGate(info({}));
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByPlaceholderText('XXXX-XXXX-XXXX')).toBeNull();
  });

  it('sends OIDC sign-ins to the provider', async () => {
    await renderGate(info({ mode: 'oidc' }));
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/auth/login');
  });

  it('asks for a new password before anything else on a temporary one', async () => {
    await renderGate(info({ user: { ...USER, mustChangePassword: true } }));
    expect(screen.getByText(NEW_PASSWORD.title)).toBeTruthy();
    expect(screen.queryByText(/Sheet for/)).toBeNull();
  });

  it('warns over plain http when the session cookie is https-only', async () => {
    setUrl('http://clockspan.lan/');
    await renderGate(info({ cookieSecure: true }));
    expect(screen.getByText(HTTPS_ONLY.hint)).toBeTruthy();
    cleanup();
    await renderGate(info({ cookieSecure: false }));
    expect(screen.queryByText(HTTPS_ONLY.hint)).toBeNull();
  });

  it('asks the server again when a request finds the session gone', async () => {
    await renderGate(info({ user: USER }));
    vi.mocked(api.getAuth).mockResolvedValue(info({}));
    window.dispatchEvent(new Event(api.UNAUTHENTICATED_EVENT));
    await settle();
    expect(api.getAuth).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
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
});
