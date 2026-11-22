'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { runInNewContext } = require('node:vm');
const DesktopBridge = require('./desktop-bridge.cjs');
const { desktopEndpoint } = require('./desktop-transport.cjs');

const endpoint = 'ws://localhost:9229/devtools/page/TEST_ONLY';
const page = { type: 'page', url: 'app://-/index.html?initialRoute=%2F', webSocketDebuggerUrl: endpoint };

test('desktop discovery accepts only a unique local Codex renderer on the requested port', () => {
  assert.equal(desktopEndpoint([page], 9229), endpoint.replace('localhost', '127.0.0.1'));
  const ipv6 = endpoint.replace('localhost', '[::1]');
  assert.equal(desktopEndpoint([{ ...page, webSocketDebuggerUrl: ipv6 }], 9229, '[::1]'), ipv6);
  assert.equal(desktopEndpoint([{ ...page, webSocketDebuggerUrl: ipv6 }], 9229), null);
  assert.equal(desktopEndpoint([{ ...page, webSocketDebuggerUrl: ipv6.replace('[::1]', '[::]') }], 9229, '[::1]'), null);
  assert.equal(desktopEndpoint([page, { ...page, webSocketDebuggerUrl: endpoint + '2' }], 9229), null);
  assert.equal(desktopEndpoint([{ ...page, url: 'https://example.invalid/index.html' }], 9229), null);
  assert.equal(desktopEndpoint([{ ...page, url: 'app://fs/index.html' }], 9229), null);
  assert.equal(desktopEndpoint([{ ...page, url: 'app://-/assets/index.html' }], 9229), null);
  assert.equal(desktopEndpoint([{ ...page, type: 'worker' }], 9229), null);
  for (const bad of [
    endpoint.replace('localhost', 'example.invalid'),
    endpoint.replace('localhost', 'localhost.example.invalid'),
    endpoint.replace('localhost', 'name@localhost'),
    endpoint.replace('9229', '9230'),
    endpoint.replace('/page/', '/browser/'),
    endpoint + '?token=synthetic',
  ]) assert.equal(desktopEndpoint([{ ...page, webSocketDebuggerUrl: bad }], 9229), null, bad);
});

async function until(predicate) {
  for (let i = 0; i < 100; ++i) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail('bridge did not reach expected state');
}

test('desktop bridge reaches an IPv6-only renderer without following redirects', async t => {
  const visited = [], connected = [];
  const ipv6 = endpoint.replace('localhost', '[::1]');
  class Socket {
    constructor(url) { connected.push(url); }
    close() {}
  }
  const bridge = new DesktopBridge(() => {}, () => {}, {
    Socket, fetcher: async (url, init) => {
      assert.equal(init.redirect, 'error');
      visited.push(url);
      if (!url.includes('[::1]')) return { ok: false };
      return { ok: true, json: async () => [{ ...page, webSocketDebuggerUrl: ipv6 }] };
    },
  });
  t.after(() => bridge.stop());
  bridge.start();
  await until(() => connected.length);
  assert.deepEqual(visited, ['http://127.0.0.1:9229/json/list', 'http://[::1]:9229/json/list']);
  assert.deepEqual(connected, [ipv6]);
});

test('desktop bridge verifies initialization, relays approvals, and does not replay on reconnect', async t => {
  const sockets = [], requests = [], resolved = [], activity = [];
  class Socket {
    constructor(url) {
      assert.equal(url, endpoint.replace('localhost', '127.0.0.1'));
      this.n = sockets.push(this);
      this.sent = [];
      queueMicrotask(() => { this.readyState = 1; this.onopen(); });
    }
    send(input) {
      const command = JSON.parse(input);
      this.sent.push(command);
      if (command.method === 'test/wait') return;
      let result = {};
      if (command.method === 'Page.getFrameTree') result = { frameTree: { frame: { id: 'main' } } };
      if (command.method === 'Runtime.enable') {
        this.deliver({ method: 'Runtime.executionContextCreated', params: { context: { id: 9, auxData: { frameId: 'child', isDefault: true } } } });
        this.deliver({ method: 'Runtime.executionContextCreated', params: { context: { id: 5, auxData: { frameId: 'main', isDefault: true } } } });
      }
      if (command.method === 'Runtime.evaluate') {
        assert.equal(command.params.contextId, 5);
        let value = { observed: true, requests: [] };
        if (command.params.expression.startsWith('(function installRelay')) {
          const window = {
            electronBridge: { sendMessageFromView() {} },
            addEventListener: (type, listener) => { this.listener = listener; },
            __codexMobileCompanionRelay: payload => this.deliver({
              method: 'Runtime.bindingCalled', params: { name: '__codexMobileCompanionRelay', payload, executionContextId: 5 },
            }),
          };
          value = runInNewContext(command.params.expression, {
            window, location: { protocol: 'app:', hostname: this.n > 1 ? '-' : 'fs', pathname: '/index.html' },
          });
        }
        result = { result: { value } };
      }
      queueMicrotask(() => this.deliver({ id: command.id, result }));
    }
    deliver(value) { this.onmessage({ data: JSON.stringify(value) }); }
    close() { this.readyState = 3; this.onclose(); }
  }

  const bridge = new DesktopBridge(request => requests.push(request), id => { if (id !== null) resolved.push(id); }, {
    Socket, retryMs: 5, onActivity: value => activity.push(value.method),
    fetcher: async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:9229/json/list');
      assert.equal(init.redirect, 'error');
      return { ok: true, json: async () => [page] };
    },
  });
  t.after(() => bridge.stop());
  bridge.start();
  bridge.start();
  await until(() => bridge.ready && bridge.snapshotObserved);
  assert.equal(sockets.length, 2);
  assert.equal(sockets[0].sent.length, 4);
  assert.equal(sockets[1].sent.find(command => command.method === 'Runtime.addBinding').params.executionContextId, 5);
  const relay = (socket, payload, name = '__codexMobileCompanionRelay', executionContextId = 5) => {
    socket.deliver({ method: 'Runtime.bindingCalled', params: { name, payload: JSON.stringify(payload), executionContextId } });
  };
  const request = { type: 'mcp-request', hostId: 'local', request: { id: 42, method: 'elicitation/request' } };
  relay(sockets[0], request);
  relay(sockets[1], request, 'other');
  relay(sockets[1], request, '__codexMobileCompanionRelay', 9);
  sockets[1].listener({ source: {}, data: request });
  sockets[1].listener({ source: null, data: request });
  sockets[1].listener({ source: null, data: { type: 'mcp-notification', method: 'serverRequest/resolved', params: { requestId: 42 } } });
  assert.deepEqual(requests.map(value => value.id), ['desktop:42']);
  assert.deepEqual(resolved, ['desktop:42']);
  assert.deepEqual(activity, ['serverRequest/resolved']);

  const rejected = assert.rejects(bridge.call('test/wait'), /disconnected/);
  sockets[1].close();
  assert.equal(bridge.ready, false);
  assert.equal(bridge.snapshotObserved, false);
  await rejected;
  await until(() => sockets.length === 3 && bridge.ready);
  assert.ok(!sockets[2].sent.some(command => command.method === 'test/wait'));
  bridge.stop();
  await delay(20);
  assert.equal(sockets.length, 3);
});

test('native goal edits reject stale objectives and statuses without writing', async () => {
  const bridge = new DesktopBridge(() => {}, () => {});
  const current = { objective: 'Original objective', status: 'active' };
  const writes = [];
  const manager = {
    sendRequest: async method => {
      assert.equal(method, 'thread/goal/get');
      return { goal: current };
    },
    setThreadGoal: async (id, options) => {
      writes.push([id, { ...options }]);
      return { objective: options.objective };
    },
  };
  bridge.syncPending = async () => {};
  bridge.call = async (method, { expression }) => {
    assert.equal(method, 'Runtime.evaluate');
    return { result: { value: await runInNewContext(expression, { window: { __mobileCompanionManager: manager } }) } };
  };
  const edit = { objective: 'Edited objective', previousObjective: current.objective, previousStatus: current.status };
  await assert.rejects(bridge.goalMutation('fixture', 'edit', { ...edit, previousObjective: 'Stale' }), { code: 'GOAL_CONFLICT' });
  await assert.rejects(bridge.goalMutation('fixture', 'edit', { ...edit, previousStatus: 'paused' }), { code: 'GOAL_CONFLICT' });
  assert.deepEqual(writes, []);
  assert.equal((await bridge.goalMutation('fixture', 'edit', edit)).goal.objective, edit.objective);
  assert.deepEqual(writes, [['fixture', { objective: edit.objective, appendTranscriptItem: false }]]);
});
