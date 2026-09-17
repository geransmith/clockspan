import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as api from '../api';
import { UNAUTHENTICATED_EVENT } from '../api';
import type { AuthInfo } from '../types';
import { LoginPage, OidcLoginPage } from './LoginPage';
import { SetupPage } from './SetupPage';

interface AuthCtx {
  auth: AuthInfo;
  refresh: () => Promise<void>;
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
        },
        (err: Error) => setError(err.message),
      ),
    [],
  );

  useEffect(() => {
    void refresh();
    const onUnauth = () => void refresh();
    window.addEventListener(UNAUTHENTICATED_EVENT, onUnauth);
    return () => window.removeEventListener(UNAUTHENTICATED_EVENT, onUnauth);
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
          <p className="error">Can’t reach the server: {error}</p>
          <button className="btn btn-primary" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      </div>
    );
  }
  if (!auth || !value) return <div className="gate" aria-busy="true" />;
  if (auth.mode === 'none' || auth.user) return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
  if (auth.mode === 'local' && auth.setupRequired) return <SetupPage onDone={refresh} />;
  if (auth.mode === 'local') return <LoginPage onDone={refresh} />;
  return <OidcLoginPage />;
}

export function useAuth(): AuthCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthGate');
  return v;
}
