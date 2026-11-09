/* Moments service worker: offline app shell + daily reminder notifications. */
const VERSION = 'moments-v6';
const SHELL = [
  './',
  './index.html',
  './styles.css?v=6',
  './app.js?v=6',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-180.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first for navigations (so updates land), cache first for assets.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(VERSION).then((c) => c.put('./index.html', copy)); return res; })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});

/* ---------- Reminders ----------
   The server sends an empty push at the user's chosen time. It knows nothing
   about their moments; this worker reads them on the phone and picks the words. */

function readMemories() {
  return new Promise((resolve) => {
    const r = indexedDB.open('moments');
    // Never create the database from here: that would block the app's own setup.
    r.onupgradeneeded = () => { r.transaction.abort(); };
    r.onerror = () => resolve([]);
    r.onsuccess = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('memories')) { db.close(); return resolve([]); }
      const q = db.transaction('memories').objectStore('memories').getAll();
      q.onsuccess = () => { db.close(); resolve(q.result.filter((m) => !m.deleted)); };
      q.onerror = () => { db.close(); resolve([]); };
    };
  });
}

const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

async function pickMessage() {
  const ms = await readMemories();
  const now = new Date();
  const tk = dayKey(now);
  const past = ms.filter((m) => { const d = new Date(m.createdAt); return d.getDate() === now.getDate() && dayKey(d) !== tk && d < now; });
  if (past.length) {
    const oldest = past.reduce((a, b) => (a.createdAt < b.createdAt ? a : b));
    const d = new Date(oldest.createdAt);
    const years = now.getFullYear() - d.getFullYear() - (now.getMonth() < d.getMonth() ? 1 : 0);
    const months = (now.getFullYear() - d.getFullYear()) * 12 + now.getMonth() - d.getMonth();
    const when = years >= 1 ? (years === 1 ? 'A year ago today' : `${years} years ago today`) : (months === 1 ? 'A month ago today' : `${months} months ago today`);
    return { title: when, body: 'Tap to relive it.', open: 'otd' };
  }
  if (ms.some((m) => dayKey(new Date(m.createdAt)) === tk)) {
    return { title: 'Today’s moment is in', body: 'Take a minute to relive your week so far.', open: 'week' };
  }
  return { title: 'What’s today’s moment?', body: 'Tap for a photo, hold for a video, say a line about it.', open: 'camera' };
}

self.addEventListener('push', (e) => {
  e.waitUntil(pickMessage().then((msg) => self.registration.showNotification(msg.title, {
    body: msg.body,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: 'moments-daily',
    renotify: false,
    data: { open: msg.open },
  })));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const open = (e.notification.data && e.notification.data.open) || 'week';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).pathname.startsWith(new URL(self.registration.scope).pathname));
    if (win) { await win.focus(); win.postMessage({ open }); return; }
    await self.clients.openWindow(`./?open=${encodeURIComponent(open)}`);
  })());
});
