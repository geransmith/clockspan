import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as api from '../api';
import type { AuthInfo } from '../types';
import { HTTPS_ONLY, SERVER_UNREACHABLE } from '../lib/copy';
import { LoginPage, OidcLoginPage } from './LoginPage';
import { NewPasswordPage } from './NewPasswordPage';
import { SetupPage } from './SetupPage';

interface AuthCtx {
  auth: AuthInfo;
  /** Re-reads `/api/auth/me`; resolves with the answer, or null when the server did not answer. */
  refresh: () => Promise<AuthInfo | null>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthGate({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    () =>
      api.getAuth().then(
        (next) => {
          setAuth(next);
          setError(null);
          return next;
        },
        (err: unknown) => {
          setError((err as Error).message);
          return null;
        },
      ),
    [],
  );

  useEffect(() => {
    void refresh();
    const onUnauth = () => void refresh();
    window.addEventListener(api.UNAUTHENTICATED_EVENT, onUnauth);
    return () => window.removeEventListener(api.UNAUTHENTICATED_EVENT, onUnauth);
  }, [refresh]);

  const signOut = useCallback(async () => {
    const res = await api.logout().catch(() => null);
    if (res?.redirect) {
      window.location.href = res.redirect;
      return;
    }
    await refresh();
  }, [refresh]);

  const value = useMemo(() => (auth ? { auth, refresh, signOut } : null), [auth, refresh, signOut]);

  if (error && !auth) {
    return (
      <div className="gate">
        <div className="gate-card">
          <h1>Clockspan</h1>
          <p className="error" role="alert">
            {SERVER_UNREACHABLE.body(error)}
          </p>
          <button className="btn btn-primary" onClick={() => void refresh()}>
            {SERVER_UNREACHABLE.retry}
          </button>
        </div>
      </div>
    );
  }
  if (!auth || !value) return <div className="gate" aria-busy="true" />;
  if (auth.user?.mustChangePassword) return <NewPasswordPage user={auth.user} onDone={refresh} onSignOut={signOut} />;
  if (auth.mode === 'none' || auth.user) return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
  // A Secure cookie set from a plain-http page is discarded by the browser, so the sign-in
  // would look like it did nothing. Say so up front (localhost counts as secure in most
  // browsers, but a dev server never sets APP_URL to https anyway).
  const hint = auth.cookieSecure && window.location.protocol === 'http:' ? HTTPS_ONLY.hint : null;
  if (auth.mode === 'local' && auth.setupRequired) return <SetupPage onDone={refresh} hint={hint} />;
  if (auth.mode === 'local') return <LoginPage onDone={refresh} hint={hint} />;
  return <OidcLoginPage hint={hint} />;
}

export function useAuth(): AuthCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthGate');
  return v;
}
