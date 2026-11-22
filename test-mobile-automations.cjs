'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { readThreadAutomations } = require('./mobile-automations.cjs');

const listed = '12345678-1234-1234-1234-123456789abc';
const unlisted = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const metadata = ({ id = listed, status = 'ACTIVE', kind = 'heartbeat' } = {}) => (
  `kind = "${kind}"\nstatus = "${status}"\ntarget_thread_id = "${id}"\n`
);

async function fixture(t) {
  const tmp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'companion-automations-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'automations');
  await fs.mkdir(root);
  return { root, tmp };
}

async function add(root, name, contents) {
  const dir = path.join(root, name);
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'automation.toml'), contents);
}

test('only returns active and paused counts for listed heartbeat targets', async t => {
  const { root } = await fixture(t);
  await add(root, 'one', '\uFEFF# Fixture only\r\n' + metadata({ id: listed.toUpperCase() }) +
    'title = "Example task"\nprompt = "Private fixture \\nText"\napi_version = 1\n');
  await add(root, 'two', metadata({ status: 'PAUSED' }));
  await add(root, 'three', metadata({ id: unlisted }));
  await add(root, 'four', metadata({ kind: 'cron' }));
  await add(root, 'five', metadata({ status: 'UNKNOWN' }));
  const result = await readThreadAutomations(root, [listed.toUpperCase(), 'invalid', '__proto__']);
  assert.deepEqual(result, { [listed]: { active: 1, paused: 1 } });
  assert.deepEqual(await readThreadAutomations(root, []), {});
  assert.deepEqual(await readThreadAutomations(undefined, [listed]), {});
  assert.deepEqual(await readThreadAutomations('relative/automations', [listed]), {});
});

test('ignores ambiguous TOML, oversized files and invalid UTF-8', async t => {
  const { root } = await fixture(t);
  await add(root, 'one', 'prompt = """\n' + metadata() + '"""\n');
  await add(root, 'two', metadata() + 'status = "PAUSED"\n');
  await add(root, 'three', '[extra]\n' + metadata());
  await add(root, 'four', metadata() + '#'.padEnd(33 * 1024, 'x'));
  await add(root, 'five', Buffer.concat([Buffer.from(metadata()), Buffer.from([0xff])]));
  assert.deepEqual(await readThreadAutomations(root, [listed]), {});
});

test('rejects linked roots, task directories and metadata files', async t => {
  const { root, tmp } = await fixture(t);
  const outside = path.join(tmp, 'other');
  await fs.mkdir(outside);
  await add(outside, 'task', metadata());
  const alternate = path.join(tmp, 'linked-root');
  await fs.symlink(outside, alternate, 'junction');
  await fs.symlink(path.join(outside, 'task'), path.join(root, 'linked-task'), 'junction');
  assert.deepEqual(await readThreadAutomations(alternate, [listed]), {});
  const linkedFiles = path.join(root, 'linked-file-task');
  await fs.mkdir(linkedFiles);
  await fs.link(path.join(outside, 'task', 'automation.toml'), path.join(linkedFiles, 'automation.toml'));
  assert.deepEqual(await readThreadAutomations(root, [listed]), {});
  await t.test('file symlink where supported by the test host', async sub => {
    const task = path.join(root, 'symlinked-file-task');
    await fs.mkdir(task);
    try {
      await fs.symlink(path.join(outside, 'task', 'automation.toml'), path.join(task, 'automation.toml'), 'file');
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
        sub.skip('Windows host does not allow unprivileged file symlinks');
        return;
      }
      throw error;
    }
    assert.deepEqual(await readThreadAutomations(root, [listed]), {});
  });
});

test('does not return partial counts when enumeration exceeds its bound', async t => {
  const { root } = await fixture(t);
  await add(root, 'valid', metadata());
  for (let i = 0; i < 256; i++) await fs.mkdir(path.join(root, String(i)));
  assert.deepEqual(await readThreadAutomations(root, [listed]), {});
});
