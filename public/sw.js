/* 서비스 워커 — 푸시 알림 담당 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = {}; }

  const title = d.title || '새 메시지';
  const options = {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/badge-72.png',
    tag: d.roomId || 'chat',          // 같은 방 알림은 하나로 겹쳐 쌓이지 않게
    renotify: true,
    data: { roomId: d.roomId || null },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const roomId = event.notification.data && event.notification.data.roomId;

  event.waitUntil((async () => {
    const list = await self.clients.matchAll({
      type: 'window', includeUncontrolled: true,
    });
    for (const client of list) {
      if ('focus' in client) {
        await client.focus();
        client.postMessage({ type: 'open-room', roomId });
        return;
      }
    }
    await self.clients.openWindow('/');
  })());
});
