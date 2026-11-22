'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { win32 } = require('node:path');
const DesktopBridge = require('./desktop-bridge.cjs');
const { readThreadAutomations } = require('./mobile-automations.cjs');

const nativeMethods = new Set([
  'thread/list', 'thread/read', 'thread/turns/list', 'thread/goal/get',
  'thread/archive', 'thread/name/set', 'model/list', 'turn/interrupt',
]);
const invalid = message => Object.assign(Error(message), { code: 'INVALID_ACTION' });
const unavailable = () => Object.assign(Error('请在电脑上启动支持手机连接的 Codex 后重试。'), { code: 'DESKTOP_UNAVAILABLE', definitive: true });
const stale = () => Object.assign(Error('此审批已处理或连接已变更。请刷新后核对。'), { code: 'APPROVAL_STALE' });
const goalStates = new Set(['active', 'paused', 'complete', 'blocked', 'stalled', 'budgetLimited', 'usageLimited']);
const validGoalText = value => typeof value === 'string' && Boolean(value.trim()) && [...value].length <= 4000;

function createDesktopAdapter({ Bridge = DesktopBridge, port, automationDirectory } = {}) {
  const subscribers = new Set(), approvals = new Map(), resolved = new Set(), responding = new Set();
  const unreadIds = new Set();
  const goalWrites = new Set();
  let session = 0, revision = 0, healthResult, healthCheck;
  const emit = value => { for (const fn of subscribers) fn(value); };
  const changed = () => emit({ type: 'mcp-notification', method: 'phone/approvalsChanged' });
  const bridge = new Bridge(
    request => {
      if (request.__hostId !== 'local') return;
      resolved.delete(request.id);
      ++revision;
      changed();
    },
    id => {
      ++revision;
      if (id === null) {
        ++session;
        approvals.clear();
        resolved.clear();
        healthResult = undefined;
        healthCheck = undefined;
      } else {
        resolved.add(id);
        approvals.delete(id);
      }
      changed();
    },
    { port, onActivity: value => { if (!value.hostId || value.hostId === 'local') emit(value); } },
  );
  const requireReady = () => { if (!bridge.ready) throw unavailable(); };
  const offline = { ready: false, code: 'DESKTOP_UNAVAILABLE', message: '请在电脑上启动支持手机连接的 Codex 后重试。' };
  const incompatible = { ready: false, code: 'DESKTOP_RESTART_REQUIRED', message: '未确认桌面版本支持手机连接，请检查公开版的兼容说明。' };

  async function health() {
    if (!bridge.ready) return offline;
    if (healthResult?.expires > Date.now()) return healthResult.value;
    if (!healthCheck) {
      const checkedSession = session;
      const check = bridge.healthCheck().then(capabilities => {
        if (!bridge.ready || session !== checkedSession) return offline;
        const ready = capabilities.read === true && capabilities.send === true && capabilities.approvals === true;
        const value = ready ? { ready: true, code: 'READY', capabilities } : incompatible;
        healthResult = { value, expires: Date.now() + 3000 };
        return value;
      }).catch(() => bridge.ready && session === checkedSession ? incompatible : offline)
        .finally(() => { if (healthCheck === check) healthCheck = undefined; });
      healthCheck = check;
    }
    let timer;
    try {
      return await Promise.race([healthCheck, new Promise(resolve => {
        timer = setTimeout(() => resolve({ ready: false, code: 'DESKTOP_CHECK_PENDING', message: '正在检查桌面连接，请稍后重试。' }), 5000);
      })]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function readApprovals() {
    const startedSession = session, startedRevision = revision;
    if (!bridge.ready) return false;
    const snapshot = await bridge.syncPending();
    if (!bridge.ready || startedSession !== session || startedRevision !== revision || !snapshot?.observed) return false;
    const seen = new Set();
    for (const request of snapshot.requests) {
      if (request.__hostId !== 'local' || !['number', 'string'].includes(typeof request.__desktopId)) continue;
      seen.add(request.id);
      if (resolved.has(request.id)) continue;
      const signature = JSON.stringify([request.method, request.params]);
      const old = approvals.get(request.id);
      if (old?.signature !== signature) approvals.set(request.id, { key: 'desktop:' + randomUUID(), request, signature });
    }
    for (const key of approvals.keys()) if (!seen.has(key)) approvals.delete(key);
    for (const key of resolved) if (!seen.has(key)) resolved.delete(key);
    return true;
  }

  async function recent() {
    requireReady();
    const result = await bridge.request('thread/list', { archived: false, limit: 50 });
    if (!Array.isArray(result?.data)) throw Error('Desktop did not return the conversation list');
    return result.data;
  }

  async function mutateGoal(threadId, action, value) {
    if (goalWrites.has(threadId)) throw Object.assign(Error('目标正在更新，请稍后核对。'), { code: 'GOAL_CONFLICT' });
    goalWrites.add(threadId);
    try { return await bridge.goalMutation(threadId, action, value); }
    finally { goalWrites.delete(threadId); }
  }

  return {
    start: () => bridge.start(),
    stop: () => bridge.stop(),
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    health,
    async rpc(method, params = {}) {
      requireReady();
      const { threadId } = params;
      if (method === 'thread/fork' || method === 'thread/resume') return bridge.lifecycle(method, params);
      if (method === 'thread/settings/read') return bridge.settings(threadId);
      if (method === 'thread/settings/update') return bridge.settings(threadId, params);
      if (method === 'thread/goal/clear') return mutateGoal(threadId, 'clear');
      if (method === 'thread/goal/set') {
        const { objective, status, previousObjective, previousStatus } = params;
        if (validGoalText(objective) && status === undefined) {
          if (previousObjective === undefined && previousStatus === undefined) return mutateGoal(threadId, 'create', objective.trim());
          if (validGoalText(previousObjective) && goalStates.has(previousStatus)) {
            return mutateGoal(threadId, 'edit', { objective: objective.trim(), previousObjective, previousStatus });
          }
        }
        if (objective === undefined && previousObjective === undefined && previousStatus === undefined && ['paused', 'active'].includes(status)) {
          return mutateGoal(threadId, 'status', status);
        }
        throw invalid('目标内容或状态无效。');
      }
      if (!nativeMethods.has(method)) throw invalid('不支持此桌面操作。');
      return bridge.request(method, params);
    },
    async workspaces() {
      const projects = new Map(), assignments = {};
      for (const thread of await recent()) {
        if (typeof thread.cwd !== 'string' || !win32.isAbsolute(thread.cwd)) continue;
        const root = win32.normalize(thread.cwd);
        const id = createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 20);
        if (!projects.has(id)) projects.set(id, { id, name: win32.basename(root) || root, roots: [root] });
        assignments[thread.id] = { projectId: id };
      }
      return { projects: [...projects.values()], assignments };
    },
    async threadState() {
      const threads = await recent();
      const ids = threads.map(thread => thread.id);
      return { threads, unreadIds: ids.filter(id => unreadIds.has(id)),
        ...(automationDirectory && { threadAutomations: await readThreadAutomations(automationDirectory, ids) }) };
    },
    async setUnread(id, unread) {
      if (unread) {
        if (unreadIds.size >= 1000) unreadIds.delete(unreadIds.values().next().value);
        unreadIds.add(id);
      } else unreadIds.delete(id);
    },
    async send(...args) { requireReady(); return bridge.send(...args); },
    async lifecycle(method, ...args) {
      requireReady();
      if (method !== 'thread/start') throw invalid('不支持此操作。');
      return bridge.lifecycle(method, ...args);
    },
    async operationStatus(id) { requireReady(); return bridge.operationStatus(id); },
    async approvals() {
      const desktopConnected = await readApprovals();
      const requests = desktopConnected ? [...approvals.values()].filter(entry => !responding.has(entry.key))
        .map(({ key, request }) => ({ id: key, method: request.method, params: request.params })) : [];
      return { desktopConnected, requests };
    },
    async respond(id, result) {
      if (!await readApprovals()) throw unavailable();
      const entry = [...approvals.values()].find(candidate => candidate.key === id);
      if (!entry || responding.has(id)) throw stale();
      const currentSession = session;
      responding.add(id);
      try {
        await bridge.respond(entry.request, result);
        if (currentSession === session && approvals.get(entry.request.id) === entry) {
          resolved.add(entry.request.id);
          approvals.delete(entry.request.id);
        }
        changed();
      } finally {
        responding.delete(id);
      }
    },
  };
}

module.exports = { createDesktopAdapter };
