'use strict';

function desktopEndpoint(pages, port, host = '127.0.0.1') {
  if (!Array.isArray(pages) || !['127.0.0.1', '[::1]'].includes(host)) return null;
  const endpoints = new Set();
  for (const page of pages) {
    if (page?.type !== 'page' || typeof page.url !== 'string' ||
        typeof page.webSocketDebuggerUrl !== 'string') continue;
    try {
      const renderer = new URL(page.url);
      const endpoint = new URL(page.webSocketDebuggerUrl);
      if (renderer.protocol !== 'app:' || renderer.host !== '-' || renderer.pathname !== '/index.html' ||
          renderer.username || renderer.password) continue;
      if (endpoint.protocol !== 'ws:' || ![host, 'localhost'].includes(endpoint.hostname) ||
          Number(endpoint.port || 80) !== port || endpoint.username || endpoint.password ||
          endpoint.search || endpoint.hash || !/^\/devtools\/page\/[a-z0-9_-]+$/i.test(endpoint.pathname)) continue;
      endpoints.add('ws://' + host + ':' + port + endpoint.pathname);
    } catch {}
  }
  return endpoints.size === 1 ? [...endpoints][0] : null;
}

class DesktopTransport {
  constructor({ port = 9229, fetcher = globalThis.fetch, Socket = globalThis.WebSocket, retryMs = 5000 } = {}) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid desktop port');
    Object.assign(this, {port, fetcher, Socket, retryMs});
    this.ready = false;
    this.running = false;
    this.generation = 0;
    this.pending = new Map();
    this.next = 1;
  }

  start() {
    if (this.running) return;
    this.running = true;
    void this.connect(++this.generation);
  }

  stop() {
    this.running = false;
    ++this.generation;
    clearTimeout(this.retry);
    this.disconnect(this.socket);
  }

  schedule(generation) {
    if (this.running && generation === this.generation) {
      this.retry = setTimeout(() => void this.connect(generation), this.retryMs);
      this.retry.unref?.();
    }
  }

  async connect(generation) {
    try {
      let endpoint;
      for (const host of ['127.0.0.1', '[::1]']) {
        if (generation !== this.generation) return;
        try {
          const response = await this.fetcher('http://' + host + ':' + this.port + '/json/list', {
            signal: AbortSignal.timeout(1500), redirect: 'error',
          });
          if (response.ok) endpoint = desktopEndpoint(await response.json(), this.port, host);
        } catch {}
        if (endpoint) break;
      }
      if (generation !== this.generation) return;
      if (!endpoint) throw Error('No unique local Codex renderer');
      const socket = this.socket = new this.Socket(endpoint);
      this.openTimer = setTimeout(() => this.disconnect(socket), 2000);
      socket.onmessage = event => {
        if (socket !== this.socket) return;
        try {
          const value = JSON.parse(event.data);
          if (value.id !== undefined) {
            const pending = this.pending.get(value.id);
            if (value.error) pending?.finish(Error(value.error.message));
            else pending?.finish(null, value.result);
          } else if (value.method === 'Runtime.executionContextsCleared' && this.ready) {
            this.disconnect(socket);
          } else {
            this.onEvent?.(value);
          }
        } catch {}
      };
      socket.onopen = async () => {
        if (socket !== this.socket) return;
        clearTimeout(this.openTimer);
        try {
          await this.initialize();
          if (socket !== this.socket) return;
          this.ready = true;
          this.onReady?.();
        } catch {
          this.disconnect(socket);
        }
      };
      socket.onclose = socket.onerror = () => this.disconnect(socket);
    } catch {
      this.schedule(generation);
    }
  }

  disconnect(socket) {
    if (!socket || socket !== this.socket) return;
    clearTimeout(this.openTimer);
    this.socket = null;
    this.ready = false;
    for (const pending of this.pending.values()) pending.finish(Error('Desktop bridge disconnected'));
    this.onDisconnect?.();
    try { socket.close(); } catch {}
    this.schedule(this.generation);
  }

  call(method, params = {}) {
    const socket = this.socket;
    if (socket?.readyState !== 1) return Promise.reject(Error('Desktop bridge not connected'));
    return new Promise((resolve, reject) => {
      const id = this.next++;
      const finish = (error, value) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => finish(Error('Desktop bridge response timed out')), 15000);
      this.pending.set(id, {finish});
      try { socket.send(JSON.stringify({id, method, params})); }
      catch (error) { finish(error); }
    });
  }
}

module.exports = {DesktopTransport, desktopEndpoint};
