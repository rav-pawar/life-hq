/* Life HQ service worker: push handling, IndexedDB storage, offline app shell.
   The encrypted data file is fetched network-first; plaintext is never cached. */
importScripts('./config.js', './db.js');

const CACHE = 'life-hq-v17'; // v17: Wiki tab (packed + encrypted, SVG diagrams as images, sanitized tree, no HTML) and Ideas tracker (idea.add / idea.edit / idea.status / idea.delete, shared Undo toast); v16: only the 'Tasks' Google list expanded (others collapsed, state kept), Tasks-list due dates in Today + 'Upcoming in 5 days', Dismiss / Restore for email to-dos and notices; v15: To-do section (Google Tasks read-only, grouped by list; Life HQ email to-dos tickable via todo.done / todo.undone), due/overdue to-dos in Today, Google Tasks re-connect note; v14: nav fits at 900px+, Today festival tip collapsed (all lines) + long lists collapsed, notes inline edit (note.edit) + Undo toast on delete; v13: Marathi in Devanagari + festival label dedupe, maintenance summary + collapsible appliance rows, calendar + to-do blocks in Today, email details (more ▸) + From email notices, notes to self (note.add / note.delete sync); v12: #8 charging uses synced lastCharged; alerts Dismiss on urgent + Older group (not counted as urgent), alert card spacing, school holiday view; v11: update checker (every 2.5 min + on focus) with idle-gated apply / "Update available" pill, cache-busted shell install (keep APP_VERSION in app.js equal); v10: force refresh for Mac mini + festivals; v9: festival day observe tips; v8: festivals section; v7: sync token auto-provisioned from the encrypted data; v6: sync back (encrypted inbox); v5: auto-refresh + network-first data (v4: single-row header; v3: per-device keys, data v2)
const DATA_KEY = new URL('./data.enc.json', self.registration.scope).href; // cached without the cache-busting query
const SHELL = [
  './', './index.html', './styles.css', './app.js', './db.js', './config.js', './logic.js', './crypto.js',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'
];

self.addEventListener('install', event => {
  // Each shell file is fetched with a cache-busting query + no-store, so neither the HTTP cache (GitHub Pages max-age=600)
  // nor a CDN edge can hand the new worker an old copy; it is stored under the clean URL.
  // skipWaiting + clients.claim: the new worker takes over at once; open pages show "Update available" and reload
  // when you are idle (they can also ask with a SKIP_WAITING message).
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map(async u => {
      const clean = new URL(u, self.registration.scope);
      const bust = new URL(clean.href); bust.searchParams.set('v', CACHE);
      const res = await fetch(bust.href, { cache: 'no-store' });
      if (!res.ok) throw new Error('shell fetch failed: ' + u + ' ' + res.status);
      await cache.put(clean.href, res);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('life-hq-') && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Stale-while-revalidate for same-origin GETs; navigations fall back to the cached index.html offline.
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/sw.js')) return; // update checks always go to the network
  if (url.pathname.endsWith('/data.enc.json')) {
    // Network-first (no-store, query keeps the CDN from answering with a stale copy) so a fresh publish shows up
    // at once; the cached copy keeps it working offline and is marked X-Life-HQ-Offline: 1 for the page.
    event.respondWith(fetchData(req.url).catch(async () => {
      const cached = await (await caches.open(CACHE)).match(DATA_KEY);
      if (!cached) return Response.error();
      return new Response(await cached.blob(), { status: 200, headers: { 'Content-Type': 'application/json', 'X-Life-HQ-Offline': '1' } });
    }));
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
    // Revalidate (no-cache: conditional request, not the possibly-stale HTTP cache); don't store one-off ?query copies.
    const network = fetch(req, { cache: 'no-cache' }).then(res => {
      if (res && res.ok && res.type === 'basic' && (!url.search || req.mode === 'navigate')) cache.put(req.mode === 'navigate' ? url.origin + url.pathname : req, res.clone());
      return res;
    }).catch(() => null);
    if (cached) { event.waitUntil(network); return cached; }
    const res = await network;
    if (res) return res;
    if (req.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
    return Response.error();
  })());
});

async function fetchData(url) {
  const u = new URL(url || DATA_KEY);
  if (!u.searchParams.has('t')) u.searchParams.set('t', Date.now().toString(36));
  const res = await fetch(u.href, { cache: 'no-store' });
  if (!res || !res.ok) { if (res && res.status === 404) return res; throw new Error('data fetch failed ' + (res && res.status)); }
  await (await caches.open(CACHE)).put(DATA_KEY, res.clone());
  return res;
}

function normalize(raw) {
  let p = raw;
  if (!p || typeof p !== 'object') p = { body: String(raw || '') };
  const type = ['urgent', 'summary', 'info'].includes(p.type) ? p.type : 'info';
  const ts = typeof p.ts === 'number' ? p.ts : (Date.parse(p.ts) || Date.now());
  return {
    id: String(p.id || (type + '-' + ts + '-' + Math.random().toString(36).slice(2, 8))),
    type,
    title: String(p.title || (type === 'summary' ? 'Daily summary' : 'Life HQ')),
    body: String(p.body || ''),
    items: Array.isArray(p.items) ? p.items.map(String) : undefined,
    ts,
    url: p.url ? String(p.url) : undefined
  };
}

function notificationFor(a) {
  const base = {
    tag: a.id,
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    timestamp: a.ts,
    data: { id: a.id, url: a.url || null, type: a.type }
  };
  if (a.type === 'urgent') {
    const title = a.title.includes('🚨') ? a.title : '🚨 ' + a.title;
    return [title, Object.assign(base, {
      body: a.body, requireInteraction: true, renotify: true, vibrate: [300, 100, 300, 100, 600]
    })];
  }
  if (a.type === 'summary') {
    const title = a.title.includes('📋') ? a.title : '📋 ' + a.title;
    let body = a.body;
    if (a.items && a.items.length) {
      const preview = a.items.slice(0, 4).map(i => '• ' + i).join('\n');
      body = (body ? body + '\n' : '') + preview + (a.items.length > 4 ? `\n…and ${a.items.length - 4} more` : '');
    }
    return [title, Object.assign(base, { body, vibrate: [120] })];
  }
  return [a.title, Object.assign(base, { body: a.body })];
}

async function broadcast(msg) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of clients) c.postMessage(msg);
}

async function handleIncoming(raw) {
  const a = normalize(raw);
  try { await HQDB.putAlert(a); } catch (e) { /* still show the notification */ }
  const [title, opts] = notificationFor(a);
  await self.registration.showNotification(title, opts);
  // New data is usually published with a push: refresh the offline copy, then tell open pages to refetch now.
  try { await fetchData(); } catch (e) { /* offline: pages keep their data */ }
  await broadcast({ kind: 'alert', alert: a });
}

self.addEventListener('push', event => {
  let raw = null;
  if (event.data) {
    try { raw = event.data.json(); } catch (e) { raw = { type: 'info', body: event.data.text() }; }
  }
  event.waitUntil(handleIncoming(raw));
});

// Local test from the page ("Test notification" button), goes through the same path as a real push.
self.addEventListener('message', event => {
  const d = event.data || {};
  if (d.kind === 'SKIP_WAITING' || d === 'SKIP_WAITING') { self.skipWaiting(); return; }
  if (d.kind === 'test-push') event.waitUntil(handleIncoming(d.payload));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  const scope = self.registration.scope;
  let target = new URL('./', scope).href;
  if (data.url) {
    try { target = new URL(data.url, scope).href; } catch (e) { /* keep default */ }
  }
  const sameApp = target.startsWith(scope);
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (sameApp) {
      for (const c of clients) {
        if (c.url.startsWith(scope) && 'focus' in c) {
          c.postMessage({ kind: 'focus-alert', id: data.id }); // the page also refetches the data on this
          return c.focus();
        }
      }
    }
    // External url (e.g. a bank page) or app not open: open a new window.
    if (!sameApp) await broadcast({ kind: 'focus-alert', id: data.id });
    return self.clients.openWindow(sameApp ? target + (target.includes('#') ? '' : '#' + encodeURIComponent(data.id || '')) : target);
  })());
});

// Browser rotated the subscription: re-subscribe and flag it so the app asks you to re-copy it.
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    try {
      const key = self.LIFE_HQ_CONFIG && self.LIFE_HQ_CONFIG.vapidPublicKey;
      const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(key) });
      await HQDB.setMeta('subChanged', { at: Date.now(), sub: sub.toJSON() });
    } catch (e) {
      await HQDB.setMeta('subChanged', { at: Date.now(), error: String(e) });
    }
    await broadcast({ kind: 'sub-changed' });
  })());
});

function urlB64ToUint8Array(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const s = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}
