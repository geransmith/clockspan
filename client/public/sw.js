// Intentionally minimal: a fetch handler is what makes the app installable, but nothing
// is cached so users never see stale assets after an update.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
