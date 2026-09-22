// Intentionally minimal: a fetch handler is what makes the app installable, but nothing
// is cached so users never see stale assets after an update.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

// Where the browser only shows notifications through the worker (Chrome on Android), alerts.ts
// shows them from here, so a tap on one lands here too: bring the app forward, or open it.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => (windows[0] ? windows[0].focus() : self.clients.openWindow('/'))),
  );
});
