'use strict';

const { constants, promises: fs } = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const maxEntries = 256;
const maxBytes = 32 * 1024;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const field = /^\s*([a-z_][a-z_0-9]*)\s*=\s*("(?:[^"\\\u0000-\u0008\u000a-\u001f\u007f]|\\(?:["\\btnfr]|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}))*"|[0-9]+|true|false)\s*(?:#.*)?$/;

function parseMetadata(source) {
  const seen = new Set();
  let kind, target, status;
  // Accept the flat scalar format Codex writes; never interpret multiline prompt text as metadata.
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const match = field.exec(line);
    if (!match || seen.has(match[1])) return null;
    const [, key, value] = match;
    seen.add(key);
    if (key === 'kind') kind = value;
    if (key === 'target_thread_id') target = value;
    if (key === 'status') status = value;
  }
  if (kind !== '"heartbeat"' || !['"ACTIVE"', '"PAUSED"'].includes(status) ||
      !target?.startsWith('"') || !uuid.test(target.slice(1, -1))) return null;
  return { id: target.slice(1, -1).toLowerCase(), active: status === '"ACTIVE"' };
}

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function plainDirectory(directory) {
  const { root } = path.parse(directory);
  let parent = root;
  for (const name of directory.slice(root.length).split(path.sep).filter(Boolean)) {
    parent = path.join(parent, name);
    if (!(await fs.lstat(parent)).isDirectory()) return false;
  }
  return samePath(await fs.realpath(directory), directory);
}

async function readMetadata(directory) {
  if (!await plainDirectory(directory)) return null;
  const file = path.join(directory, 'automation.toml');
  const before = await fs.lstat(file);
  if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes ||
      !samePath(await fs.realpath(file), file)) return null;
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const opened = await handle.stat();
    // These checks reject ordinary indirection, not an adversary racing a writable local directory.
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.size > maxBytes || !samePath(await fs.realpath(file), file)) return null;
    const bytes = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maxBytes) return null;
    return parseMetadata(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
  } finally {
    await handle.close();
  }
}

async function readThreadAutomations(directory, threadIds) {
  const counts = {};
  const listed = new Set((Array.isArray(threadIds) ? threadIds : []).filter(id => typeof id === 'string' && uuid.test(id))
    .map(id => id.toLowerCase()));
  if (!listed.size || typeof directory !== 'string' || !path.isAbsolute(directory)) return counts;
  if (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(directory)) return counts;
  const base = path.resolve(directory);
  try {
    if (!await plainDirectory(base)) return counts;
    const paths = [];
    let entries = 0;
    for await (const entry of await fs.opendir(base)) {
      if (++entries > maxEntries) return {};
      if (entry.isDirectory()) paths.push(path.join(base, entry.name));
    }
    for (const taskDirectory of paths) {
      let task;
      try { task = await readMetadata(taskDirectory); } catch { continue; }
      if (!task || !listed.has(task.id)) continue;
      const count = counts[task.id] ??= { active: 0, paused: 0 };
      count[task.active ? 'active' : 'paused']++;
    }
    return counts;
  } catch {
    return {};
  }
}

module.exports = { readThreadAutomations };
