import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { unlockAudio } from './lib/alerts';
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

// The lazy chunks (see App.tsx and Sheet.tsx) load on demand. After an upgrade an open page
// asks for the old build's files; reloading gets the new one, once the saves still on their way
// have settled. Vite still throws the failed import, so the ErrorBoundary's card can show until
// the reload lands, and when no reload is made (one a moment ago, or offline) its Reload button
// is the way out.
window.addEventListener('vite:preloadError', () => void reloadForNewBuild(() => window.location.reload()));

// Every tap and key unlocks the sound: a touch's `pointerdown` isn't a user gesture, and iOS
// suspends audio again when the app goes to the background. Capture, so no handler hides one.
window.addEventListener('pointerup', unlockAudio, { capture: true });
window.addEventListener('keydown', unlockAudio, { capture: true });

// The service worker caches nothing; alerts.ts shows notifications through it where the
// browser refuses `new Notification()` (Chrome on Android).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
