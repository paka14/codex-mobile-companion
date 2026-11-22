'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createMobilePage } = require('./mobile-page.cjs');

const origin = 'https://companion.example.test';
const ownerLogin = 'owner@example.test';
const serve = createMobilePage({ mode: 'tailscale-owner', origin, ownerLogin });

function request(url, { method = 'GET', headers = {}, ip = '127.0.0.1' } = {}) {
  const response = {};
  const res = {
    writeHead(status, values) { Object.assign(response, { status, headers: values }); return this; },
    end(body) { response.body = body; },
  };
  response.handled = serve({
    url, method, socket: { remoteAddress: ip },
    headers: { host: new URL(origin).host, 'x-forwarded-proto': 'https', 'tailscale-user-login': ownerLogin, ...headers },
  }, res);
  return response;
}

test('serves the mobile UI on the authorized origin without link credentials', () => {
  const result = request('/mobile?thread=example');
  assert.equal(result.status, 200);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.match(result.body, /data-mobile-auth="tailscale"/);
  assert.match(result.body, /new EventSource\('\/mobile-api\/events'\)/);
  assert.doesNotMatch(result.body, /Bearer |codex-mobile-token|\/web\/_bridge/);
  const controls = request('/mobile-controls.js');
  assert.equal(controls.status, 200);
  assert.doesNotMatch(controls.body.toString(), /Bearer /);
  assert.equal(request('/mobile', { method: 'HEAD' }).body, undefined);
  const worker = request('/mobile-diagnostics-sw.js');
  assert.equal(worker.status, 200);
  assert.equal(worker.headers['Service-Worker-Allowed'], '/mobile');
  assert.match(request('/mobile-diagnostics-offline.html').body.toString(), /data-diagnostics-offline/);
});

test('rejects unexpected login, origin, source address and methods', () => {
  assert.equal(request('/mobile?token=anything', { headers: { 'tailscale-user-login': 'other@example.test' } }).status, 403);
  assert.equal(request('/mobile-controls.js', { headers: { origin: 'https://other.example.test' } }).status, 403);
  assert.equal(request('/mobile', { ip: '192.0.2.2' }).status, 403);
  assert.equal(request('/mobile', { method: 'POST' }).status, 405);
  assert.equal(request('/mobile-diagnostics-sw.js', { headers: { 'tailscale-user-login': 'other@example.test' } }).status, 403);
  assert.equal(request('/mobile-api/events').handled, false);
});
