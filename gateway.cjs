'use strict';

const { randomUUID } = require('node:crypto');
const { mkdir, writeFile } = require('node:fs/promises');
const { createServer } = require('node:http');
const { join } = require('node:path');
const { trustedTailscale } = require('./mobile-access.cjs');
const { MobileOperations } = require('./mobile-operations.cjs');
const { createMobilePage } = require('./mobile-page.cjs');
const { MobileSnapshots } = require('./mobile-snapshot.cjs');

const threadIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const desktopMethods = new Set([
  'phone/thread/snapshot', 'thread/list', 'thread/read', 'thread/turns/list', 'thread/resume',
  'thread/fork', 'thread/archive', 'thread/name/set', 'model/list', 'thread/settings/read',
  'thread/settings/update', 'thread/goal/get', 'thread/goal/set', 'thread/goal/clear', 'turn/interrupt',
]);
const unrestrictedMethods = new Set(['thread/list', 'model/list']);
const continuationMethods = new Set([
  'phone/thread/snapshot', 'thread/list', 'thread/read', 'thread/turns/list',
  'thread/goal/get', 'turn/interrupt',
]);
const fileLimit = 20 * 1024 * 1024;
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const diagnosticCodes = new Set(['READY', 'DESKTOP_UNAVAILABLE', 'DESKTOP_RESTART_REQUIRED', 'DESKTOP_CHECK_PENDING', 'NETWORK_UNAVAILABLE']);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(res, status, data, extra = {}) {
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', ...extra });
  res.end(JSON.stringify(data));
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(req, limit) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
    throw new HttpError(415, 'Expected application/json.');
  }
  if (Number(req.headers['content-length']) > limit) {
    req.resume();
    throw new HttpError(413, 'Request is too large.');
  }
  const chunks = [];
  let size = 0;
  // Do not destroy the socket before the caller can receive a 413 response.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) { req.resume(); throw new HttpError(413, 'Request is too large.'); }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (object(value)) return value;
  } catch {}
  throw new HttpError(400, 'Invalid JSON object.');
}

async function upload(body, dataDirectory) {
  if (typeof body.name !== 'string' || typeof body.base64 !== 'string' ||
      body.base64.length > Math.ceil(fileLimit / 3) * 4) throw new HttpError(400, 'Invalid file or file exceeds 20 MB.');
  const buffer = Buffer.from(body.base64, 'base64');
  if (!buffer.length || buffer.length > fileLimit || buffer.toString('base64') !== body.base64) {
    throw new HttpError(400, 'Invalid file or file exceeds 20 MB.');
  }
  let name = body.name.split(/[\\/]/).at(-1).replace(/[<>:"|?*\x00-\x1f]/g, '_').slice(-120).replace(/[. ]+$/, '');
  if (!name || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = 'attachment';
  const directory = join(dataDirectory, 'uploads', randomUUID());
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  await writeFile(path, buffer, { flag: 'wx', mode: 0o600 });
  return { name, path, size: buffer.length, mime: String(body.mime || 'application/octet-stream').slice(0, 200) };
}

function createGateway({ origin, ownerLogin, dataDirectory, desktop, accessProfile, reportError = () => {} }) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || origin !== url.origin || url.port || !ownerLogin || !dataDirectory) {
    throw new Error('Configure an HTTPS origin, a Tailscale owner and a data directory.');
  }
  const access = { origin, ownerLogin, mode: 'tailscale-owner' };
  const continuationOnly = accessProfile === 'continue';
  const page = createMobilePage(access, continuationOnly);
  const operations = new MobileOperations(join(dataDirectory, 'operations.json'), desktop);
  const snapshots = new MobileSnapshots((method, params) => desktop.rpc(method, params));
  const listeners = new Set();
  const responding = new Set();
  const recentHealth = [];
  function diagnosticStatus(health) {
    const code = diagnosticCodes.has(health.code) ? health.code : 'DESKTOP_UNAVAILABLE';
    const row = { at: new Date().toISOString(), code, ready: code === 'READY' && health.ready === true };
    if (recentHealth.at(-1)?.code !== code) {
      recentHealth.push(row);
      if (recentHealth.length > 24) recentHealth.shift();
    }
    return row;
  }
  const publish = event => {
    const message = 'data: ' + JSON.stringify(event) + '\n\n';
    for (const res of listeners) if (!res.write(message)) res.destroy();
  };
  const unsubscribe = desktop.subscribe(publish);
  async function handle(req, res) {
    if (page(req, res)) return;
    const path = new URL(req.url, origin);
    const post = req.method === 'POST';
    if (!path.pathname.startsWith('/mobile-api/')) return json(res, 404, { error: 'Not found.' });
    if (!trustedTailscale(req, access) || (post && req.headers.origin !== origin)) {
      return json(res, 403, { error: 'Connect to Tailscale and use the private companion URL.', code: 'AUTH_REQUIRED' });
    }
    const method = (...allowed) => {
      if (allowed.includes(req.method)) return true;
      json(res, 405, { error: 'Method not allowed.' }, { Allow: allowed.join(', ') });
      return false;
    };
    switch (path.pathname) {
      case '/mobile-api/health':
      case '/mobile-api/ready': {
        if (!method('GET')) return;
        const health = await desktop.health();
        diagnosticStatus(health);
        const ready = health.ready === true;
        return json(res, path.pathname.endsWith('/ready') && !ready ? 503 : 200, { ...health, ready, schemaVersion: 1 });
      }
      case '/mobile-api/diagnostics': {
        if (!method('GET')) return;
        const health = await desktop.health().catch(() => ({ code: 'NETWORK_UNAVAILABLE' }));
        const current = { ...diagnosticStatus(health), gateway: true };
        return json(res, 200, { schemaVersion: 1, current, recent: recentHealth.slice() });
      }
      case '/mobile-api/live':
        if (method('GET')) return json(res, 200, { live: true });
        return;
      case '/mobile-api/events': {
        if (!method('GET')) return;
        if (listeners.size >= 12) return json(res, 503, { error: 'Too many event connections.' });
        res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });
        res.write(': connected\n\n');
        listeners.add(res);
        const heartbeat = setInterval(() => { if (!res.write(': heartbeat\n\n')) res.destroy(); }, 20_000);
        res.once('close', () => { clearInterval(heartbeat); listeners.delete(res); });
        return;
      }
      case '/mobile-api/desktop-rpc': {
        if (!method('POST')) return;
        const { method: name, params = {} } = await readJson(req, 128_000);
        if (!desktopMethods.has(name) || !object(params) ||
            (!unrestrictedMethods.has(name) && !threadIdPattern.test(params.threadId || ''))) {
          throw new HttpError(400, 'Unsupported desktop action or invalid conversation ID.');
        }
        if (continuationOnly && !continuationMethods.has(name)) throw new HttpError(403, 'Use Codex on the PC for this action.');
        const result = name === 'phone/thread/snapshot' ? await snapshots.get(params) : await desktop.rpc(name, params);
        return json(res, 200, result);
      }
      case '/mobile-api/workspaces':
        if (method('GET')) return json(res, 200, await desktop.workspaces());
        return;
      case '/mobile-api/thread-state': {
        if (!method('GET', 'POST')) return;
        if (post) {
          const { threadId, unread } = await readJson(req, 4000);
          if (!threadIdPattern.test(threadId || '') || typeof unread !== 'boolean') throw new HttpError(400, 'Invalid read state.');
          await desktop.setUnread(threadId, unread);
        }
        return json(res, 200, await desktop.threadState());
      }
      case '/mobile-api/operations': {
        if (!method('GET', 'POST')) return;
        if (post) {
          const input = await readJson(req, 640_000);
          if (continuationOnly && input.kind !== 'send') throw new HttpError(403, 'Start new conversations on the PC.');
          try { return json(res, 202, operations.submit(input)); }
          catch (e) {
            if (e.code) throw e;
            throw new HttpError(400, e.message);
          }
        }
        const id = path.searchParams.get('id');
        if (!threadIdPattern.test(id || '')) throw new HttpError(400, 'Invalid operation ID.');
        return json(res, 200, await operations.get(id) || { id, status: 'not_found' });
      }
      case '/mobile-api/approvals': {
        if (!method('GET', 'POST')) return;
        if (!post) return json(res, 200, await desktop.approvals());
        const { id, result } = await readJson(req, 100_000);
        if (typeof id !== 'string' || !id || id.length > 200 || !object(result)) throw new HttpError(400, 'Invalid approval response.');
        if (responding.has(id)) throw new HttpError(409, 'An approval response is already in progress.');
        responding.add(id);
        try {
          const pending = await desktop.approvals();
          if (!pending.requests.some(request => request.id === id)) throw new HttpError(409, 'Approval is no longer pending.');
          await desktop.respond(id, result);
          return json(res, 200, { ok: true });
        } finally {
          responding.delete(id);
        }
      }
      case '/mobile-api/upload':
        if (continuationOnly) throw new HttpError(403, 'Add attachments in Codex on the PC.');
        if (method('POST')) return json(res, 200, await upload(await readJson(req, 29 * 1024 * 1024), dataDirectory));
        return;
      default:
        return json(res, 404, { error: 'Not found.' });
    }
  }

  const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, (req, res) => {
    handle(req, res).catch(e => {
      if (res.headersSent || res.destroyed) return res.destroy();
      if (e instanceof HttpError) return json(res, e.status, { error: e.message });
      const status = { DESKTOP_UNAVAILABLE: 503, APPROVAL_STALE: 409, GOAL_CONFLICT: 409, INVALID_ACTION: 400 }[e.code];
      if (status) return json(res, status, { error: e.message, code: e.code });
      reportError(e);
      return json(res, 502, { error: 'The desktop operation could not be confirmed.' });
    });
  });
  server.once('close', unsubscribe);
  return {
    start(port = 0) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(server.address()); });
      });
    },
    close() {
      for (const res of listeners) res.end();
      return new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    },
  };
}

module.exports = { createGateway };
