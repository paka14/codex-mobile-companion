'use strict';

const { strict: assert } = require('node:assert');
const { randomUUID } = require('node:crypto');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { MobileOperations } = require('./mobile-operations.cjs');

function journal(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-operations-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'operations.json');
}

function newMessage() {
  return { id: randomUUID(), kind: 'send', params: { threadId: randomUUID(), text: 'Example message' } };
}

test('journals before dispatch and does not resend a repeated operation', async (t) => {
  const file = journal(t);
  const request = newMessage();
  const sent = [];
  const operations = new MobileOperations(file, {
    async send(...args) {
      sent.push(args);
      const [stored] = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(stored.status, 'pending');
      assert.equal(stored.id, request.id);
      assert.ok(!JSON.stringify(stored).includes(request.params.text));
      return { status: 'succeeded' };
    },
  });

  const receipt = operations.submit(request);
  assert.equal(receipt.status, 'pending');
  assert.ok(!Object.hasOwn(receipt, 'fingerprint'));
  assert.deepEqual(operations.submit(request), receipt);
  assert.throws(() => operations.submit({ ...request, params: { ...request.params, text: 'Different message' } }));
  await operations.running.get(request.id);
  assert.equal((await operations.get(request.id)).status, 'succeeded');
  assert.equal(operations.submit(request).status, 'succeeded');
  assert.deepEqual(sent, [[request.params.threadId, request.params.text, request.id, false]]);
});

test('checks a pending receipt after restart without dispatching again', async (t) => {
  const file = journal(t);
  const request = newMessage();
  const original = new MobileOperations(file, { send: async () => ({ status: 'pending' }) });
  original.submit(request);
  await original.running.get(request.id);

  const statusRequests = [];
  const restarted = new MobileOperations(file, {
    send: t.mock.fn(),
    async operationStatus(id) {
      statusRequests.push(id);
      return null;
    },
  });
  assert.equal(restarted.submit(request).status, 'pending');
  assert.equal((await restarted.get(request.id)).status, 'unknown');
  assert.deepEqual(statusRequests, [request.id]);
  assert.equal(restarted.bridge.send.mock.callCount(), 0);
});
