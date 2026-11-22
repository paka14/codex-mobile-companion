'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const http = require('node:http');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { createGateway } = require('./gateway.cjs');

const origin = 'https://gateway.example.test';
const ownerLogin = 'owner@example.test';
const threadId = randomUUID();
const thread = { id: threadId, name: 'Fixture', cwd: 'C:/example' };

async function fixture(t) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'companion-gateway-'));
  const requests = [{ id: 'desktop:01', method: 'item/fileChange/requestApproval' }];
  const sends = [], responses = [], calls = [];
  let ready = false, subscriber, stopCount = 0;
  let approvalBarrier = Promise.resolve();
  const desktop = {
    subscribe(fn) { subscriber = fn; return () => { stopCount++; }; },
    health: async () => ({ ready, code: ready ? 'READY' : 'DESKTOP_UNAVAILABLE' }),
    async rpc(method, params) {
      calls.push({ method, params });
      if (method === 'thread/list') return { data: [thread] };
      if (method === 'thread/read') return { thread };
      if (method === 'thread/turns/list') return { data: [{ id: 'turn', items: [{ id: 'answer', type: 'agentMessage', text: 'Example history' }] }] };
    },
    async send(id, text, operationId) {
      sends.push({ id, text, operationId });
      return { status: 'succeeded' };
    },
    async lifecycle(method, params) { return { status: 'succeeded', result: { thread: { ...thread, cwd: params.cwd } } }; },
    async approvals() { return { desktopConnected: true, requests }; },
    async respond(id, result) {
      responses.push({ id, result });
      await approvalBarrier;
      requests.shift();
    },
    async threadState() { return { unreadIds: [], threads: [thread] }; },
    async workspaces() { return { projects: [], assignments: {} }; },
  };
  const gateway = createGateway({ origin, ownerLogin, dataDirectory, desktop });
  const address = await gateway.start();
  t.after(async () => {
    await gateway.close();
    assert.equal(stopCount, 1);
    await rm(dataDirectory, { recursive: true, force: true });
  });
  assert.equal(address.address, '127.0.0.1');
  const open = (path, { raw, data, headers, method, authenticated = true } = {}) => {
    const body = raw ?? (data === undefined ? undefined : JSON.stringify(data));
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: address.address, port: address.port, path, method: method || (body === undefined ? 'GET' : 'POST'),
        headers: {
          Host: new URL(origin).host, 'X-Forwarded-Proto': 'https',
          ...(authenticated ? { 'Tailscale-User-Login': ownerLogin } : {}),
          ...(body !== undefined ? { Origin: origin, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
          ...headers,
        },
      }, resolve);
      req.on('error', reject);
      req.end(body);
    });
  };
  const request = async (...args) => {
    const res = await open(...args);
    const chunks = [];
    for await (const chunk of res) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    return { status: res.statusCode, body: res.headers['content-type']?.includes('json') ? JSON.parse(body) : body };
  };
  return {
    open, request, sends, responses, calls,
    ready: () => { ready = true; },
    publish: event => subscriber(event),
    pauseApproval() {
      const gate = Promise.withResolvers();
      approvalBarrier = gate.promise;
      return gate.resolve;
    },
  };
}

test('requires owner identity and same-origin writes, even with a legacy link token', async t => {
  const { request, calls } = await fixture(t);
  const path = '/mobile-api/desktop-rpc';
  const data = { method: 'thread/list' };
  for (const headers of [{ Origin: 'https://other.example.test' }, { Origin: '' }, { Host: 'other.example.test' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await request(path, { data, headers })).status, 403);
  }
  assert.equal((await request(path + '?token=fake', { data, authenticated: false })).status, 403);
  assert.equal((await request('/mobile', { authenticated: false })).status, 403);
  assert.equal((await request('/mobile')).status, 200);
  assert.equal((await request(path, { data: { method: 'thread/start' } })).status, 400);
  assert.equal((await request(path, { data: { method: 'thread/pin', params: { threadId, pinned: true } } })).status, 400);
  assert.equal((await request(path, { data: { method: 'thread/read' } })).status, 400);
  assert.equal((await request(path, { raw: '[]' })).status, 400);
  assert.equal((await request(path, { raw: 'x'.repeat(128_001) })).status, 413);
  assert.equal((await request(path, { data, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal(calls.length, 0);
});

test('reports desktop readiness and serves the same conversation history', async t => {
  const { request, ready } = await fixture(t);
  assert.equal((await request('/mobile-api/ready')).status, 503);
  ready();
  const health = await request('/mobile-api/health');
  assert.deepEqual(health.body, { ready: true, code: 'READY', schemaVersion: 1 });
  const rpc = data => request('/mobile-api/desktop-rpc', { data });
  assert.deepEqual((await rpc({ method: 'thread/list' })).body.data, [thread]);
  const snapshot = await rpc({ method: 'phone/thread/snapshot', params: { threadId } });
  assert.equal(snapshot.body.thread.id, threadId);
  assert.equal(snapshot.body.thread.turns[0].items[0].text, 'Example history');
  const same = await rpc({ method: 'phone/thread/snapshot', params: { threadId, revision: snapshot.body.revision } });
  assert.equal(same.body.unchanged, true);
});

test('deduplicates HTTP sends and forwards only pending approval responses', async t => {
  const { request, sends, responses, pauseApproval } = await fixture(t);
  const path = '/mobile-api/operations';
  const id = randomUUID();
  const data = { id, kind: 'send', params: { threadId, text: 'Example message' } };
  assert.equal((await request(path, { data })).status, 202);
  assert.equal((await request(path, { data })).status, 202);
  await t.waitFor(async () => {
    assert.equal((await request(path + '?id=' + id)).body.status, 'succeeded');
  });
  assert.deepEqual(sends, [{ id: threadId, text: 'Example message', operationId: id }]);

  const approvals = '/mobile-api/approvals';
  assert.equal((await request(approvals)).body.requests[0].id, 'desktop:01');
  const response = { id: 'desktop:01', result: { decision: 'decline' } };
  const release = pauseApproval();
  const firstResponse = request(approvals, { data: response });
  try {
    await t.waitFor(() => assert.equal(responses.length, 1));
    assert.equal((await request(approvals, { data: response })).status, 409);
  } finally {
    release();
  }
  assert.equal((await firstResponse).status, 200);
  assert.equal((await request(approvals, { data: response })).status, 409);
  assert.deepEqual(responses, [response]);
});

test('protects the event stream and publishes desktop activity over SSE', async t => {
  const { request, open, publish } = await fixture(t);
  assert.equal((await request('/mobile-api/events', { authenticated: false })).status, 403);
  const res = await open('/mobile-api/events');
  assert.equal(res.headers['content-type'], 'text/event-stream');
  try {
    const connected = await once(res, 'data');
    assert.match(connected[0].toString(), /: connected/);
    const data = once(res, 'data');
    publish({ type: 'mcp-notification', method: 'turn/completed', params: { threadId } });
    assert.match((await data)[0].toString(), /turn\/completed/);
  } finally {
    res.destroy();
  }
});

test('stores an upload within its own directory and rejects malformed base64', async t => {
  const { request } = await fixture(t);
  const path = '/mobile-api/upload';
  const data = { name: '../example.txt', base64: Buffer.from('Example').toString('base64'), mime: 'text/plain' };
  const saved = await request(path, { data });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.name, 'example.txt');
  assert.equal(await readFile(saved.body.path, 'utf8'), 'Example');
  assert.equal((await request(path, { data: { ...data, base64: '??' } })).status, 400);
});
