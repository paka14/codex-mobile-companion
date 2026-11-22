'use strict';
{
  const name = 'codex-mobile-diagnostics-v1';
  const offline = '/mobile-diagnostics-offline.html';
  const script = '/mobile-diagnostics.js';
  const log = '/mobile-diagnostics-events';
  let pending = Promise.resolve();
  self.addEventListener('install', event => event.waitUntil((async () => {
    const cache = await caches.open(name);
    await cache.addAll([new Request(offline, { cache: 'reload' }), new Request(script, { cache: 'reload' })]);
    await self.skipWaiting();
  })()));
  self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
  async function record(code, status) {
    const cache = await caches.open(name);
    const previous = await cache.match(log);
    const cutoff = Date.now() - 7 * 86400000;
    let rows = [];
    try {
      const stored = await previous?.json();
      if (Array.isArray(stored)) rows = stored.filter(row => row && Date.parse(row.at) > cutoff).slice(-79);
    } catch {}
    rows.push({ kind: 'navigation', code, at: new Date().toISOString(), ...(status ? { status } : {}) });
    await cache.put(log, new Response(JSON.stringify(rows), { headers: { 'Content-Type': 'application/json' } }));
  }
  self.addEventListener('fetch', event => {
    const { request } = event;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin || request.method !== 'GET') return;
    if (url.pathname === script) {
      if (url.searchParams.has('offline')) {
        event.respondWith((async () => (await caches.match(script, { cacheName: name })) || fetch(request))());
      }
      return;
    }
    if (url.pathname !== '/mobile' || request.mode !== 'navigate') return;
    event.respondWith((async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      let response, code;
      try { response = await fetch(request, { signal: controller.signal }); }
      catch { code = controller.signal.aborted ? 'TIMEOUT' : 'FETCH_FAILED'; }
      finally { clearTimeout(timeout); }
      if (response && response.status < 400) return response;
      pending = pending.catch(() => {}).then(() => record(code || 'HTTP_ERROR', response?.status));
      await pending.catch(() => {});
      if (response && response.status < 500) return response;
      return (await caches.match(offline, { cacheName: name }).catch(() => null)) || response || Response.error();
    })());
  });
}
