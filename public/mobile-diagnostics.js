'use strict';
(() => {
  const key = 'codex-mobile-diagnostics-v1';
  const cacheName = key;
  const workerLog = '/mobile-diagnostics-events';
  const kinds = new Set(['health', 'navigation', 'socket', 'request', 'script', 'network']);
  const codes = new Set(['READY', 'AUTH_REQUIRED', 'BACKEND_UNAVAILABLE', 'DESKTOP_NOT_RUNNING',
    'DESKTOP_RESTART_REQUIRED', 'DESKTOP_BRIDGE_UNAVAILABLE', 'DESKTOP_ADAPTER_UNAVAILABLE',
    'DESKTOP_UNAVAILABLE', 'DESKTOP_CHECK_PENDING', 'NETWORK_UNAVAILABLE', 'FETCH_FAILED', 'TIMEOUT', 'HTTP_ERROR', 'RECONNECTED', 'DISCONNECTED',
    'PAGE_ERROR', 'PROMISE_REJECTION', 'ONLINE', 'OFFLINE']);
  const limit = 80, retention = 7 * 86400000;
  const el = id => document.getElementById(id);
  function safe(kind, details = {}, at = new Date().toISOString()) {
    if (!kinds.has(kind) || typeof at !== 'string' || !Number.isFinite(Date.parse(at))) return null;
    const status = details?.status;
    return { at: new Date(at).toISOString(), kind,
      ...(codes.has(details?.code) ? { code: details.code } : {}),
      ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}) };
  }
  function clean(value) {
    return (Array.isArray(value) ? value.slice(-limit) : [])
      .map(row => row && safe(row.kind, row, row.at))
      .filter(row => row && Date.parse(row.at) > Date.now() - retention);
  }
  let memory = [], storageUnavailable = false, server = null, lastHealth = null;
  function local() {
    if (storageUnavailable) return clean(memory);
    try { return clean(JSON.parse(localStorage.getItem(key) || '[]')); } catch { return clean(memory); }
  }
  function store(rows) {
    memory = rows;
    try { localStorage.setItem(key, JSON.stringify(rows)); } catch { storageUnavailable = true; }
  }
  function record(kind, details) {
    const row = safe(kind, details);
    if (!row) return;
    if (kind === 'health') {
      if (row.code === lastHealth) return;
      lastHealth = row.code;
    }
    const rows = local();
    if (rows.slice(-12).some(old => old.kind === row.kind && old.code === row.code
      && old.status === row.status && Date.parse(row.at) - Date.parse(old.at) < 5000)) return;
    store([...rows, row].slice(-limit));
  }
  window.codexDiagnostics = { record };
  window.addEventListener('error', () => record('script', { code: 'PAGE_ERROR' }), true);
  window.addEventListener('unhandledrejection', () => record('script', { code: 'PROMISE_REJECTION' }));
  window.addEventListener('online', () => record('network', { code: 'ONLINE' }));
  window.addEventListener('offline', () => record('network', { code: 'OFFLINE' }));
  async function report() {
    let worker = [];
    try {
      const cache = await caches.open(cacheName);
      const response = await cache.match(workerLog);
      if (response) worker = clean(await response.json());
    } catch {}
    const events = [...local(), ...worker].sort((a, b) => a.at.localeCompare(b.at)).slice(-limit);
    return { schemaVersion: 1, exportedAt: new Date().toISOString(), events, server };
  }
  async function render() {
    const data = await report();
    el('diagnosticsOutput').textContent = JSON.stringify(data, null, 2);
    return data;
  }
  async function refresh(button) {
    button.disabled = true;
    const label = el('diagnosticsStatus');
    label.textContent = '正在检查电脑端状态…';
    server = null;
    try {
      const response = await fetch('/mobile-api/diagnostics', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!response.ok) {
        record('request', { code: 'HTTP_ERROR', status: response.status });
        throw Error();
      }
      const value = await response.json();
      if (value.schemaVersion !== 1 || !codes.has(value.current?.code)) throw Error();
      const status = row => ({ ...safe('health', { code: row.code }, row.at),
        ...Object.fromEntries(['ready', 'gateway', 'backend', 'desktop'].filter(key => typeof row[key] === 'boolean')
          .map(key => [key, row[key]])) });
      server = { current: status(value.current), recent: (Array.isArray(value.recent) ? value.recent : [])
        .slice(-24).filter(row => row && codes.has(row.code)).map(status) };
      label.textContent = '已取得电脑端状态';
    } catch { label.textContent = '未取得电脑端状态'; }
    finally { button.disabled = false; await render(); }
  }
  function init() {
    const offline = document.body.hasAttribute('data-diagnostics-offline');
    if (!offline && 'serviceWorker' in navigator && window.isSecureContext) {
      navigator.serviceWorker.register('/mobile-diagnostics-sw.js', { scope: '/mobile' })
        .catch(() => record('script', { code: 'PAGE_ERROR' }));
    }
    const dialog = el('diagnosticsDialog');
    for (const id of ['diagnosticsOpen', 'diagnosticsConnection']) {
      el(id)?.addEventListener('click', () => { dialog.showModal(); void render(); });
    }
    el('diagnosticsClose')?.addEventListener('click', () => dialog.close());
    el('diagnosticsRetry')?.addEventListener('click', () => location.reload());
    el('diagnosticsRefresh')?.addEventListener('click', event => void refresh(event.currentTarget));
    el('diagnosticsClear')?.addEventListener('click', async () => {
      store([]); server = null; lastHealth = null;
      try { await (await caches.open(cacheName)).delete(workerLog); } catch {}
      el('diagnosticsStatus').textContent = '已清空本机记录';
      await render();
    });
    el('diagnosticsExport')?.addEventListener('click', async () => {
      const data = await render();
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url; link.download = 'codex-connection-diagnostics.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    if (offline) void render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
