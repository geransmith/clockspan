import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as api from '../api';
import type { AuthInfo } from '../types';
import { warnQuietly } from '../lib/alerts';
import { HTTPS_ONLY, SERVER_UNREACHABLE, SIGN_OUT_FAILED } from '../lib/copy';
import { adoptUser, AUTH_USER_KEY, readStored } from '../lib/storage';
import { LoginPage, OidcLoginPage } from './LoginPage';
import { NewPasswordPage } from './NewPasswordPage';
import { SetupPage } from './SetupPage';

interface AuthCtx {
  auth: AuthInfo;
  /** Resolves true when this device is signed out or on its way out, false when the session is still here (a banner says so). */
  signOut: () => Promise<boolean>;
}

const Ctx = createContext<AuthCtx | null>(null);

/** Who an answer opens the app for: a user on their own password (under AUTH_MODE=none, /me always names the default user), or null for a gate page. */
function appUser(a: AuthInfo): number | null {
  return a.user && !a.user.mustChangePassword ? a.user.id : null;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The user this page opened the app for, once it has. */
  const openFor = useRef<number | null>(null);
  /** The page is on its way out (a reload or a sign-out's navigation), so nothing more is asked. */
  const leaving = useRef(false);

  const leave = useCallback((go: () => void) => {
    if (leaving.current) return;
    leaving.current = true;
    go();
  }, []);

  const refresh = useCallback((): Promise<AuthInfo | null> => {
    if (leaving.current) return Promise.resolve(null);
    return api.getAuth().then(
      (next) => {
        // An answer that lands once the page is leaving would only undo what the sign-out recorded.
        if (leaving.current) return next;
        const key = appUser(next);
        if (openFor.current !== null && key !== openFor.current) {
          // A page load ends the old user's write queues, drafts, banners and tab title. Taking
          // the app down in place would flush them (a draft saves on unmount) under the new cookie.
          leave(() => window.location.reload());
          return next;
        }
        adoptUser(key);
        if (key !== null) openFor.current = key;
        setAuth(next);
        setError(null);
        return next;
      },
      (err: unknown) => {
        setError((err as Error).message);
        return null;
      },
    );
  }, [leave]);

  useEffect(() => {
    void refresh();
    const onUnauth = () => void refresh();
    window.addEventListener(api.UNAUTHENTICATED_EVENT, onUnauth);
    return () => window.removeEventListener(api.UNAUTHENTICATED_EVENT, onUnauth);
  }, [refresh]);

  // Another tab that signs someone in or out changes this tab's cookie too, and no request of this
  // one would notice (the new cookie is valid). Not before the first answer: until refresh has
  // recorded this tab's user, what is stored is the last page's.
  const answered = auth !== null;
  useEffect(() => {
    if (!answered) return;
    const check = () => {
      const stored = readStored(AUTH_USER_KEY);
      if (stored !== null && stored !== String(openFor.current ?? '')) leave(() => window.location.reload());
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === AUTH_USER_KEY) check();
    };
    const onPageShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      // Back to a page from the bfcache: whatever it left for is over, and it runs again.
      leaving.current = false;
      check();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('pageshow', onPageShow);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('pageshow', onPageShow);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [answered, leave]);

  const signOut = useCallback(async () => {
    const res = await api.logout().catch(() => null);
    if (res) {
      // Recorded before leaving: the provider's page never runs this app to tell the other tabs.
      leave(() => {
        adoptUser(null);
        window.location.assign(res.redirect ?? '/');
      });
      return true;
    }
    // A logout that timed out or met a proxy's error page may still have reached the server; the read says which.
    const next = await refresh();
    if (leaving.current || next?.user === null) return true;
    if (openFor.current !== null) warnQuietly({ title: SIGN_OUT_FAILED, tag: 'sign-out-failed' });
    return false;
  }, [leave, refresh]);

  const value = useMemo(() => (auth ? { auth, signOut } : null), [auth, signOut]);
  const retry = () => void refresh();

  if (!auth) return error ? <Unreachable error={error} onRetry={retry} /> : <div className="gate" aria-busy="true" />;
  if (appUser(auth) !== null) return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
  // A gate page whose write went through (a new password, setup, a sign-in) but whose re-read
  // failed. Sending the form again would be refused (the temporary password is gone, setup is
  // done), so Retry reads /me again instead.
  if (error) return <Unreachable error={error} onRetry={retry} />;
  if (auth.user?.mustChangePassword) return <NewPasswordPage user={auth.user} onDone={refresh} onSignOut={signOut} />;
  // A Secure cookie set from a plain-http page is discarded by the browser, so the sign-in
  // would look like it did nothing. Say so up front (localhost counts as secure in most
  // browsers, but a dev server never sets APP_URL to https anyway).
  const hint = auth.cookieSecure && window.location.protocol === 'http:' ? HTTPS_ONLY.hint : null;
  if (auth.mode === 'local' && auth.setupRequired) return <SetupPage onDone={refresh} hint={hint} />;
  if (auth.mode === 'local') return <LoginPage onDone={refresh} hint={hint} />;
  return <OidcLoginPage hint={hint} />;
}

function Unreachable({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="gate">
      <div className="gate-card">
        <h1>Clockspan</h1>
        <p className="error" role="alert">
          {SERVER_UNREACHABLE.body(error)}
        </p>
        <button className="btn btn-primary" onClick={onRetry}>
          {SERVER_UNREACHABLE.retry}
        </button>
      </div>
    </div>
  );
}

export function useAuth(): AuthCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthGate');
  return v;
}
