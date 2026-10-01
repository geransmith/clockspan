// Nothing is cached, so users never see stale assets after an update. There is no fetch handler:
// Chrome needs none to offer Install, and it warns that an empty one is a no-op.
self.addEventListener('install', () => self.skipWaiting());

// Where the browser only shows notifications through the worker (Chrome on Android), alerts.ts
// shows them from here, so a tap on one lands here too: bring the app forward, or open it.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => (windows[0] ? windows[0].focus() : self.clients.openWindow('/'))),
  );
});
