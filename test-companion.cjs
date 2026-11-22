'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdir, mkdtemp, realpath, rm, writeFile } = require('node:fs/promises');
const http = require('node:http');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { loadConfig, startCompanion } = require('./companion.cjs');
const { createDesktopAdapter } = require('./desktop-adapter.cjs');

const origin = 'https://fixture.example.test';
const ownerLogin = 'fixture@example.test';
const threadId = randomUUID();
const thread = { id: threadId, cwd: String.raw`C:\Example\Fixture`, preview: 'Fixture' };
const approval = {
  id: 'desktop:1', __desktopId: 1, __hostId: 'local',
  method: 'item/fileChange/requestApproval', params: { threadId },
};

function mockDesktop() {
  let instance;
  class Bridge {
    constructor(onRequest, onResolved, options) {
      Object.assign(this, { onRequest, onResolved, options, ready: false, pending: [approval], sends: [], responses: [] });
      instance = this;
    }
    start() { this.ready = true; }
    stop() { this.ready = false; this.onResolved(null); }
    async healthCheck() { return { read: true, send: true, approvals: true }; }
    async syncPending() { return { observed: true, requests: this.pending }; }
    async request(name) {
      if (name === 'thread/list') return { data: [thread] };
      if (name === 'thread/goal/get') return { goal: this.goal ?? null };
      if (name === 'thread/read') return { thread };
      if (name === 'thread/turns/list') return { data: [{ id: 'turn', items: [{ id: 'history', type: 'agentMessage', text: 'Desktop history' }] }] };
      throw Error('Unexpected request');
    }
    async send(...args) { this.sends.push(args); return { status: 'succeeded' }; }
    async goalMutation(id, action, value) {
      assert.equal(id, threadId);
      if (action === 'create') this.goal = { objective: value, status: 'active' };
      if (action === 'edit') {
        if (this.goal?.objective !== value.previousObjective || this.goal?.status !== value.previousStatus) {
          throw Object.assign(Error('Fixture conflict'), { code: 'GOAL_CONFLICT' });
        }
        this.goal.objective = value.objective;
      }
      if (action === 'status') this.goal.status = value;
      if (action === 'clear') { this.goal = null; return { cleared: true }; }
      return { goal: this.goal };
    }
    async respond(...args) { this.responses.push(args); }
  }
  return { Bridge, get bridge() { return instance; } };
}

test('reads an explicit config and never uses its origin as a bind address', async t => {
  const root = await mkdtemp(join(tmpdir(), 'companion-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'fixture.json');
  await writeFile(file, '\uFEFF' + JSON.stringify({ origin, ownerLogin }));
  assert.deepEqual(await loadConfig(file), { origin, ownerLogin, port: 4317, desktopPort: 9229, dataDirectory: join(root, 'data') });
  await writeFile(file, JSON.stringify({ origin, ownerLogin, automationDirectory: root }));
  assert.equal((await loadConfig(file)).automationDirectory, root);
  await writeFile(file, JSON.stringify({ origin, ownerLogin, automationDirectory: 'relative' }));
  await assert.rejects(loadConfig(file), /absolute local path/);
  for (const extra of [{ origin: origin + '/path' }, { origin: origin.replace('https:', 'http:') }, { port: 9229 }, { ownerLogin: '' }]) {
    await writeFile(file, JSON.stringify({ origin, ownerLogin, ...extra }));
    await assert.rejects(loadConfig(file), /Invalid HTTPS/);
  }
});

async function checkDesktopOperations(t, accessProfile) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'companion-app-'));
  const fake = mockDesktop();
  const automationDirectory = join(directory, 'automations');
  await mkdir(join(automationDirectory, 'fixture'), { recursive: true });
  await writeFile(join(automationDirectory, 'fixture', 'automation.toml'),
    'kind = "heartbeat"\ntarget_thread_id = "' + threadId + '"\nstatus = "ACTIVE"\nprompt = "fixture not returned"\n');
  const app = await startCompanion({ origin, ownerLogin, dataDirectory: directory, automationDirectory, accessProfile, port: 0, desktopPort: 9262 }, {
    makeDesktop: options => createDesktopAdapter({ ...options, Bridge: fake.Bridge }),
  });
  t.after(async () => {
    await app.close();
    assert.equal(fake.bridge.ready, false);
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal(app.address.address, '127.0.0.1');
  assert.equal(fake.bridge.options.port, 9262);
  const request = (path, data, login = ownerLogin) => new Promise((resolve, reject) => {
    const buffer = data === undefined ? undefined : Buffer.from(JSON.stringify(data));
    const req = http.request({
      host: app.address.address, port: app.address.port, path,
      method: buffer ? 'POST' : 'GET',
      headers: {
        host: new URL(origin).host, 'x-forwarded-proto': 'https', 'tailscale-user-login': login,
        ...(buffer && { origin, 'content-type': 'application/json', 'content-length': buffer.length }),
      },
    }, async res => {
      try {
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) });
      } catch (error) { reject(error); }
    });
    req.on('error', reject);
    req.end(buffer);
  });
  assert.equal((await request('/mobile-api/ready', undefined, 'untrusted@example.test')).status, 403);
  assert.equal((await request('/mobile-api/ready')).body.ready, true);
  const rpc = (method, params) => request('/mobile-api/desktop-rpc', { method, params });
  assert.equal((await rpc('thread/list')).body.data[0].id, threadId);
  assert.equal((await request('/mobile-api/thread-state', undefined, 'untrusted@example.test')).status, 403);
  assert.deepEqual((await request('/mobile-api/thread-state')).body.threadAutomations, { [threadId]: { active: 1, paused: 0 } });
  const setGoal = params => rpc('thread/goal/set', { threadId, ...params });
  if (accessProfile === 'continue') {
    assert.equal((await setGoal({ objective: 'Forbidden' })).status, 403);
    for (const method of ['thread/goal/clear', 'thread/settings/update', 'thread/name/set', 'thread/archive', 'thread/fork']) {
      assert.equal((await rpc(method, { threadId })).status, 403);
    }
    assert.equal((await request('/mobile-api/operations', { id: randomUUID(), kind: 'create', params: {} })).status, 403);
    assert.equal((await request('/mobile-api/upload', {})).status, 403);
    assert.equal((await rpc('thread/goal/get', { threadId })).status, 200);
    assert.equal(fake.bridge.goal, undefined);
  } else {
    assert.equal((await setGoal({ objective: 'Original objective' })).body.goal.objective, 'Original objective');
    assert.equal((await setGoal({ objective: 'Edited objective', previousObjective: 'Original objective' })).status, 400);
    assert.equal((await setGoal({ objective: 'Edited objective', previousObjective: 'Stale objective', previousStatus: 'active' })).status, 409);
    assert.equal((await setGoal({ objective: 'Edited objective', previousObjective: 'Original objective', previousStatus: 'active' })).body.goal.objective, 'Edited objective');
    assert.equal((await setGoal({ status: 'paused' })).body.goal.status, 'paused');
    assert.equal((await rpc('thread/goal/get', { threadId })).body.goal.status, 'paused');
    assert.equal((await rpc('thread/goal/clear', { threadId })).body.cleared, true);
  }
  assert.equal((await request('/mobile-api/workspaces')).body.projects[0].name, 'Fixture');
  const { body: snapshot } = await rpc('phone/thread/snapshot', { threadId });
  assert.equal(snapshot.thread.turns[0].items[0].text, 'Desktop history');
  const operations = '/mobile-api/operations';
  const id = randomUUID(), operation = { id, kind: 'send', params: { threadId, text: 'fixture only' } };
  assert.equal((await request(operations, operation)).status, 202);
  assert.equal((await request(operations, operation)).status, 202);
  await t.waitFor(async () => assert.equal((await request(operations + '?id=' + id)).body.status, 'succeeded'));
  assert.deepEqual(fake.bridge.sends, [[threadId, 'fixture only', id, false]]);
  const path = '/mobile-api/approvals';
  const { body: pending } = await request(path);
  assert.equal(pending.desktopConnected, true);
  const [mobileApproval] = pending.requests;
  assert.deepEqual(Object.keys(mobileApproval).sort(), ['id', 'method', 'params']);
  assert.match(mobileApproval.id, /^desktop:/);
  assert.notEqual(mobileApproval.id, approval.id);
  const decision = { decision: 'decline' };
  assert.equal((await request(path, { id: mobileApproval.id, result: decision })).status, 200);
  assert.equal((await request(path, { id: mobileApproval.id, result: decision })).status, 409);
  assert.deepEqual(fake.bridge.responses, [[approval, decision]]);
  fake.bridge.stop();
  assert.equal((await request('/mobile-api/ready')).status, 503);
  assert.deepEqual((await request(path)).body, { desktopConnected: false, requests: [] });
  fake.bridge.start();
  assert.notEqual((await request(path)).body.requests[0].id, mobileApproval.id);
}
test('public entry serves legacy desktop-backed operations', t => checkDesktopOperations(t));
test('continuation profile allows history, sends and approvals without expanded permissions', t => checkDesktopOperations(t, 'continue'));

test('rejects a stale approval when the native snapshot changes during lookup', async () => {
  const fake = mockDesktop();
  const desktop = createDesktopAdapter({ Bridge: fake.Bridge });
  desktop.start();
  const { requests: [request] } = await desktop.approvals();
  const lookup = Promise.withResolvers();
  fake.bridge.syncPending = () => lookup.promise;
  const response = assert.rejects(desktop.respond(request.id, { decision: 'decline' }), { code: 'DESKTOP_UNAVAILABLE' });
  fake.bridge.onResolved(approval.id);
  lookup.resolve({ observed: true, requests: [approval] });
  await response;
  assert.deepEqual(fake.bridge.responses, []);
  desktop.stop();
});
