#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');

const {
  ensureConfigGitRepo,
  snapshotConfigGit,
  configGitStatus,
  rollbackConfigGit,
} = require('../config-git-backup');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zan-config-git-'));

function git(args) {
  return execFileSync('git', ['-C', tmp, ...args], { encoding: 'utf8' });
}

try {
  fs.mkdirSync(path.join(tmp, 'packages', 'test'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'zan_data'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'configuration.yaml'), 'homeassistant:\n  packages: !include_dir_named packages\n');
  fs.writeFileSync(path.join(tmp, 'packages', 'test', 'demo.yaml'), 'input_boolean:\n  demo:\n');
  fs.writeFileSync(path.join(tmp, 'zan_data', 'home_memory.json'), '{"secret":"ignored"}\n');

  assert.deepStrictEqual(ensureConfigGitRepo(tmp), { ok: true });
  const first = snapshotConfigGit(tmp, 'initial test snapshot');
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.changed, true);
  assert.ok(first.commit);

  const tracked = git(['ls-files']);
  assert.ok(tracked.includes('configuration.yaml'));
  assert.ok(tracked.includes('packages/test/demo.yaml'));
  assert.ok(!tracked.includes('zan_data/home_memory.json'));

  fs.writeFileSync(path.join(tmp, 'packages', 'test', 'demo.yaml'), 'input_boolean:\n  demo_changed:\n');
  const second = snapshotConfigGit(tmp, 'changed package', path.join(tmp, 'packages', 'test', 'demo.yaml'));
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.changed, true);

  const status = configGitStatus(tmp);
  assert.strictEqual(status.ok, true);
  assert.strictEqual(status.dirty, false);

  const rollback = rollbackConfigGit(tmp, 'HEAD~1');
  assert.strictEqual(rollback.ok, true);
  assert.match(fs.readFileSync(path.join(tmp, 'packages', 'test', 'demo.yaml'), 'utf8'), /demo:/);
  assert.doesNotMatch(fs.readFileSync(path.join(tmp, 'packages', 'test', 'demo.yaml'), 'utf8'), /demo_changed/);

  console.log('Config git backup OK');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
