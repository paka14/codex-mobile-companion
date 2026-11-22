'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { chromium } = require('playwright');
const { renderMobile } = require('../mobile-access.cjs');

const assets = join(__dirname, '..', 'public');
const html = readFileSync(join(assets, 'mobile.html'), 'utf8');
const controls = readFileSync(join(assets, 'mobile-controls.js'));
const diagnostics = readFileSync(join(assets, 'mobile-diagnostics.js'));
const thread = {
  id: '12345678-1234-1234-1234-000000000001',
  name: 'Example conversation',
  cwd: 'C:/example',
  status: { type: 'idle' },
  turns: [{ id: 'example-turn', status: 'completed', items: [{ id: 'example-answer', type: 'agentMessage', text: 'Example history' }] }],
};
const statusThread = (suffix, name, status) => ({
  id: '12345678-1234-1234-1234-00000000000' + suffix, name, cwd: thread.cwd, status,
});
const systemError = statusThread(2, 'Synthetic error', { type: 'systemError' });
const waitingInput = statusThread(3, 'Synthetic question', { type: 'active', activeFlags: ['waitingOnUserInput'] });
const waitingApproval = statusThread(4, 'Synthetic approval', { type: 'active', activeFlags: ['waitingOnApproval'] });
const threads = [thread, systemError, waitingInput, waitingApproval];
const recentThreads = threads.map(row => ({ ...row, status: { type: 'idle' } }));
const approvalRequests = [
  { id: 'desktop:question', method: 'item/tool/requestUserInput', params: { threadId: waitingInput.id, questions: [] } },
  { id: 'desktop:approval', method: 'item/commandExecution/requestApproval', params: { threadId: waitingApproval.id } },
];

async function run() {
  const channel = process.env.PLAYWRIGHT_CHANNEL;
  const screenshots = process.env.MOBILE_FIXTURE_SCREENSHOTS;
  const continuationOnly = process.env.MOBILE_FIXTURE_CONTINUE === '1';
  const browser = await chromium.launch(channel ? { channel } : {});
  try {
    for (const width of [320, 390, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 840 }, isMobile: width < 600, hasTouch: width < 600 });
      const errors = [], requests = [], sends = [];
      const goalWrites = [];
      let goal = { objective: 'Original fixture objective', status: 'paused' };
      let showApprovalRequests = false;
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        requests.push({ path: url.pathname, hasToken: url.searchParams.has('token'), auth: request.headers().authorization });
        switch (url.pathname) {
          case '/mobile': {
            const page = renderMobile(html, 'fixture', true);
            return route.fulfill({ contentType: 'text/html; charset=utf-8', body: continuationOnly
              ? page.replace('<html ', '<html data-access-profile="continue" ') : page });
          }
          case '/mobile-controls.js': return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: controls });
          case '/mobile-diagnostics.js': return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: diagnostics });
          case '/mobile-api/diagnostics': return route.fulfill({ json: { schemaVersion: 1,
            current: { at: new Date().toISOString(), code: 'READY', ready: true, gateway: true }, recent: [] } });
          case '/mobile-api/events': return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
          case '/mobile-api/health': return route.fulfill({ json: { schemaVersion: 1, ready: true, code: 'READY' } });
          case '/mobile-api/workspaces': return route.fulfill({ json: { projects: [], assignments: {} } });
          case '/mobile-api/thread-state': return route.fulfill({ json: { unreadIds: [], threads,
            threadAutomations: { [thread.id]: { active: 1, paused: 2 } } } });
          case '/mobile-api/approvals': return route.fulfill({ json: { desktopConnected: true, requests: showApprovalRequests ? approvalRequests : [] } });
          case '/mobile-api/desktop-rpc': {
            const { method, params } = request.postDataJSON();
            if (method === 'thread/list') return route.fulfill({ json: { data: recentThreads } });
            if (method === 'phone/thread/snapshot') return route.fulfill({ json: { thread } });
            if (method === 'thread/goal/get') {
              return route.fulfill({ json: { goal: params.threadId === thread.id ? goal : null } });
            }
            if (method === 'thread/goal/set') {
              goalWrites.push({ method, params });
              if (params.threadId !== thread.id || !goal) return route.fulfill({ status: 400, json: { error: 'Invalid fixture target' } });
              if (params.objective && (params.previousObjective !== goal.objective || params.previousStatus !== goal.status)) {
                return route.fulfill({ status: 409, json: { error: 'Fixture goal was changed on desktop' } });
              }
              goal = params.objective ? { objective: params.objective, status: 'active' } : { ...goal, status: params.status };
              return route.fulfill({ json: { goal } });
            }
            if (method === 'thread/goal/clear') {
              goalWrites.push({ method, params });
              goal = null;
              return route.fulfill({ json: { cleared: true } });
            }
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
      if (continuationOnly) {
        await page.getByText(thread.name, { exact: true }).waitFor();
        for (const selector of ['#new', '.new-chat-path']) assert.equal(await page.locator(selector).isVisible(), false);
        if (screenshots) await page.screenshot({ path: join(screenshots, 'companion-continue-home-' + width + '.png') });
        await page.getByText(thread.name, { exact: true }).click();
        await page.getByText('Example history', { exact: true }).waitFor();
        for (const selector of ['#addAttachment', '#permissionsButton', '#modelButton', '#goalQuickActions', '#resumeCopy']) {
          assert.equal(await page.locator(selector).isVisible(), false);
        }
        assert.equal(await page.locator('#send').isVisible(), true);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.deepEqual(errors, []);
        if (screenshots) await page.screenshot({ path: join(screenshots, 'companion-continue-thread-' + width + '.png') });
        await page.close();
        continue;
      }
      assert.equal(await page.locator('#cwd').inputValue(), '');
      assert.equal(await page.locator('#pinnedSection').count(), 0);
      await page.locator('#diagnosticsOpen').click();
      await page.locator('#diagnosticsRefresh').click();
      await page.waitForFunction(() => document.querySelector('#diagnosticsOutput')?.textContent.includes('"gateway": true'));
      await page.locator('#diagnosticsClose').click();
      for (const [target, status, label] of [[systemError, 'error', '会话出错'], [waitingInput, 'input', '待回答'], [waitingApproval, 'waiting', '待审批']]) {
        const badge = page.locator('#threads [data-thread-id="' + target.id + '"] .thread-status[data-status="' + status + '"]');
        await badge.waitFor();
        assert.equal(await badge.getAttribute('aria-label'), label);
      }
      const clock = page.locator('#threads [data-thread-id="' + thread.id + '"] .thread-automation');
      await clock.waitFor();
      assert.equal(await clock.getAttribute('aria-label'), '自动任务：已启用 1 项，已暂停 2 项');
      assert.equal(await page.locator('#threads [data-thread-id="' + systemError.id + '"] .thread-automation').isVisible(), false);
      if (screenshots) await page.screenshot({ path: join(screenshots, 'companion-home-' + width + '.png') });
      await page.locator('#threads [data-thread-id="' + thread.id + '"] .thread-more').click();
      assert.equal(await page.getByRole('menuitem', { name: '置顶', exact: true }).count(), 0);
      await page.getByRole('menuitem', { name: '重命名', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await page.getByText(thread.name, { exact: true }).click();
      await page.getByText('Example history', { exact: true }).waitFor();
      await page.locator('#goalQuickToggle[aria-label="继续目标"]').waitFor();
      await page.locator('#prompt').fill('Keep this draft');
      const goalRow = await page.locator('#goalRow').boundingBox();
      const quickActions = await page.locator('#goalQuickActions').boundingBox();
      assert(goalRow.x >= 0 && goalRow.x + goalRow.width <= width);
      assert(quickActions.x > goalRow.x && quickActions.x + quickActions.width <= goalRow.x + goalRow.width);
      assert(quickActions.height >= 44);
      if (screenshots) await page.screenshot({ path: join(screenshots, 'companion-goal-' + width + '.png') });
      await page.locator('#goalQuickEdit').click();
      await page.locator('#goalDialog[open] #goalInput').waitFor();
      assert.equal(await page.locator('#goalInput').inputValue(), 'Original fixture objective');
      assert.equal(await page.locator('#goalCreate').textContent(), '保存并设为进行中');
      await page.locator('#goalInput').fill('Edit from phone');
      goal = { ...goal, objective: 'Changed on desktop' };
      await page.locator('#goalCreate').click();
      await page.getByText('Fixture goal was changed on desktop', { exact: false }).waitFor();
      assert.deepEqual(goalWrites.at(-1), { method: 'thread/goal/set', params: {
        threadId: thread.id, objective: 'Edit from phone', previousObjective: 'Original fixture objective', previousStatus: 'paused',
      } });
      await page.locator('#goalClose').click();
      await page.locator('#goalQuickEdit').click();
      await page.locator('#goalDialog[open] #goalInput').waitFor();
      assert.equal(await page.locator('#goalInput').inputValue(), 'Changed on desktop');
      await page.locator('#goalInput').fill('Saved from phone');
      await page.locator('#goalCreate').click();
      await page.locator('#goalObjective').filter({ hasText: /^Saved from phone$/ }).waitFor();
      await page.locator('#goalClose').click();
      await page.locator('#goalQuickToggle[aria-label="暂停目标"]').click();
      await page.locator('#goalQuickToggle[aria-label="继续目标"]').waitFor();
      assert.deepEqual(goalWrites.at(-1), { method: 'thread/goal/set', params: { threadId: thread.id, status: 'paused' } });
      await page.locator('#goalQuickToggle').click();
      await page.locator('#goalQuickToggle[aria-label="暂停目标"]').waitFor();
      assert.deepEqual(goalWrites.at(-1), { method: 'thread/goal/set', params: { threadId: thread.id, status: 'active' } });
      const beforeClear = goalWrites.length;
      page.once('dialog', dialog => dialog.dismiss());
      await page.locator('#goalQuickClear').click();
      assert.equal(goalWrites.length, beforeClear);
      page.once('dialog', dialog => dialog.accept());
      await page.locator('#goalQuickClear').click();
      await page.locator('#goalStrip').waitFor({ state: 'hidden' });
      assert.deepEqual(goalWrites.at(-1), { method: 'thread/goal/clear', params: { threadId: thread.id } });
      assert.equal(await page.locator('#prompt').inputValue(), 'Keep this draft');
      assert.equal(sends.length, 0);

      await page.locator('#prompt').fill('/');
      await page.getByText('/rename', { exact: true }).waitFor();
      assert.equal(await page.getByText('/pin', { exact: true }).count(), 0);
      if (screenshots) await page.screenshot({ path: join(screenshots, 'companion-commands-' + width + '.png') });
      await page.locator('#prompt').fill('Example message');
      await page.locator('#send').click();
      await page.waitForFunction(() => document.querySelector('#prompt').value === '');
      assert.equal(sends.length, 1);
      assert.deepEqual(sends[0].params, { threadId: thread.id, text: 'Example message' });
      showApprovalRequests = true;
      await page.locator('#approvalCount').filter({ hasText: /^待确认 2$/ }).waitFor();
      await page.locator('#approvalLater').click();
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
