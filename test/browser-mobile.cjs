'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { chromium } = require('playwright');
const { renderMobile } = require('../mobile-access.cjs');

const assets = join(__dirname, '..', 'public');
const html = readFileSync(join(assets, 'mobile.html'), 'utf8');
const controls = readFileSync(join(assets, 'mobile-controls.js'));
const thread = {
  id: '12345678-1234-1234-1234-000000000001',
  name: 'Example conversation',
  cwd: 'C:/example',
  status: { type: 'idle' },
  turns: [{ id: 'example-turn', status: 'completed', items: [{ id: 'example-answer', type: 'agentMessage', text: 'Example history' }] }],
};

async function run() {
  const channel = process.env.PLAYWRIGHT_CHANNEL;
  const screenshots = process.env.MOBILE_FIXTURE_SCREENSHOTS;
  const browser = await chromium.launch(channel ? { channel } : {});
  try {
    for (const width of [320, 390, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 840 }, isMobile: width < 600, hasTouch: width < 600 });
      const errors = [], requests = [], sends = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        requests.push({ path: url.pathname, hasToken: url.searchParams.has('token'), auth: request.headers().authorization });
        switch (url.pathname) {
          case '/mobile': return route.fulfill({ contentType: 'text/html; charset=utf-8', body: renderMobile(html, 'fixture', true) });
          case '/mobile-controls.js': return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: controls });
          case '/mobile-api/events': return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
          case '/mobile-api/health': return route.fulfill({ json: { schemaVersion: 1, ready: true, code: 'READY' } });
          case '/mobile-api/workspaces': return route.fulfill({ json: { projects: [], assignments: {} } });
          case '/mobile-api/thread-state': return route.fulfill({ json: { unreadIds: [], threads: [] } });
          case '/mobile-api/approvals': return route.fulfill({ json: { desktopConnected: true, requests: [] } });
          case '/mobile-api/desktop-rpc': {
            const { method } = request.postDataJSON();
            if (method === 'thread/list') return route.fulfill({ json: { data: [thread] } });
            if (method === 'phone/thread/snapshot') return route.fulfill({ json: { thread } });
            return route.fulfill({ json: {} });
          }
          case '/mobile-api/operations': {
            const operation = request.postDataJSON();
            sends.push(operation);
            return route.fulfill({ json: { id: operation.id, status: 'succeeded' } });
          }
          default: return route.fulfill({ status: 404, json: { error: 'Unknown fixture route' } });
        }
      });
      await page.goto('https://companion.example.test/mobile');
      assert.equal(await page.locator('#cwd').inputValue(), '');
      assert.equal(await page.locator('#pinnedSection').count(), 0);
      if (screenshots) await page.screenshot({ path: join(screenshots, 'companion-home-' + width + '.png') });
      await page.locator('.thread-more').click();
      assert.equal(await page.getByRole('menuitem', { name: '置顶', exact: true }).count(), 0);
      await page.getByRole('menuitem', { name: '重命名', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await page.getByText(thread.name, { exact: true }).click();
      await page.getByText('Example history', { exact: true }).waitFor();
      await page.locator('#prompt').fill('/');
      await page.getByText('/rename', { exact: true }).waitFor();
      assert.equal(await page.getByText('/pin', { exact: true }).count(), 0);
      if (screenshots) await page.screenshot({ path: join(screenshots, 'companion-commands-' + width + '.png') });
      await page.locator('#prompt').fill('Example message');
      await page.locator('#send').click();
      await page.waitForFunction(() => document.querySelector('#prompt').value === '');
      assert.equal(sends.length, 1);
      assert.deepEqual(sends[0].params, { threadId: thread.id, text: 'Example message' });
      assert(requests.some(request => request.path === '/mobile-api/events'));
      assert(!requests.some(request => request.hasToken || request.auth || request.path === '/web/_bridge'));
      assert.deepEqual(errors, []);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
      await page.close();
      console.log('Mobile browser fixture passed at %d px', width);
    }
  } finally {
    await browser.close();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
