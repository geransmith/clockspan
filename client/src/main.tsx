import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { reloadForNewBuild } from './lib/reload';
import { applyTheme, storedTheme } from './lib/theme';
import './styles.css';

// The theme this device used last, before the settings arrive, so a forced one doesn't flash.
applyTheme(storedTheme());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

// History, Settings and drag and drop load on demand. After an upgrade an open page asks for
// the old build's files; reloading gets the new one. When it declines (a reload a moment ago),
// the error reaches the ErrorBoundary and its Reload button.
window.addEventListener('vite:preloadError', () => {
  reloadForNewBuild(Date.now(), () => window.location.reload());
});

// Pass-through service worker: makes the app installable without caching anything.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
