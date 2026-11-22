'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { chromium } = require('playwright');
const { createMobilePage } = require('../mobile-page.cjs');

async function run() {
  const origin = 'https://companion.example.test';
  const ownerLogin = 'owner@example.test';
  const serve = createMobilePage({ origin, ownerLogin, mode: 'tailscale-owner' });
  let offline = false;
  const server = createServer((req, res) => {
    if (offline) return req.socket.destroy();
    // Stand in for the private reverse proxy without contacting Tailscale.
    Object.assign(req.headers, {
      host: new URL(origin).host, 'x-forwarded-proto': 'https', 'tailscale-user-login': ownerLogin,
    });
    if (serve(req, res)) return;
    if (req.url === '/mobile-api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(': connected\n\n');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ schemaVersion: 1, code: 'READY', ready: true, data: [] }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
    const url = 'http://127.0.0.1:' + server.address().port + '/mobile';
    await page.goto(url);
    await page.waitForFunction(() => navigator.serviceWorker.controller);
    offline = true;
    await page.goto(url + '?thread=not-for-the-report');
    await page.getByRole('heading', { name: '连接诊断' }).waitFor();
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#diagnosticsExport').click()]);
    const raw = readFileSync(await download.path(), 'utf8');
    assert(!raw.includes('not-for-the-report'));
    assert(JSON.parse(raw).events.some(row => row.kind === 'navigation' && row.code === 'FETCH_FAILED'));
    assert.equal(await page.locator('#prompt').count(), 0);
    offline = false;
    await page.goto(url);
    await page.locator('#diagnosticsOpen').click();
    await page.waitForFunction(() => document.querySelector('#diagnosticsOutput')?.textContent.includes('FETCH_FAILED'));
    console.log('Companion offline diagnostics and recovery passed');
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
