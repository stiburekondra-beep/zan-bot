const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_IGNORE = [
  '# Zan local config history',
  'zan_data/',
  'home-assistant.log*',
  'home-assistant_v2.db*',
  '*.db',
  '*.db-shm',
  '*.db-wal',
  '*.log',
  'tts/',
  'deps/',
  'custom_components/',
  'www/community/',
  '',
].join('\n');

function runGit(configPath, args, opts = {}) {
  return execFileSync('git', ['-C', configPath, ...args], {
    encoding: 'utf8',
    stdio: opts.stdio || ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeout || 15000,
  });
}

function isInsideConfig(configPath, fp) {
  const rel = path.relative(configPath, fp);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function ensureConfigGitRepo(configPath) {
  if (!configPath || !fs.existsSync(configPath) || !fs.statSync(configPath).isDirectory()) {
    return { ok: false, skipped: true, reason: 'config path missing' };
  }

  try {
    if (!fs.existsSync(path.join(configPath, '.git'))) {
      runGit(configPath, ['init']);
      runGit(configPath, ['config', 'user.name', 'Zan Config Backup']);
      runGit(configPath, ['config', 'user.email', 'zan-config-backup@localhost']);
    }

    const gitignore = path.join(configPath, '.gitignore');
    if (!fs.existsSync(gitignore)) {
      fs.writeFileSync(gitignore, DEFAULT_IGNORE, 'utf8');
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function configGitStatus(configPath) {
  const repo = ensureConfigGitRepo(configPath);
  if (!repo.ok) return repo;
  try {
    const status = runGit(configPath, ['status', '--short']);
    const head = runGit(configPath, ['rev-parse', '--short', 'HEAD']).trim();
    return { ok: true, head, dirty: status.trim().length > 0, status };
  } catch (e) {
    if (/Needed a single revision|unknown revision/i.test(e.message)) {
      return { ok: true, head: null, dirty: true, status: 'initial snapshot missing' };
    }
    return { ok: false, error: e.message };
  }
}

function snapshotConfigGit(configPath, message, changedFile) {
  const repo = ensureConfigGitRepo(configPath);
  if (!repo.ok) return repo;

  try {
    let hasHead = true;
    try {
      runGit(configPath, ['rev-parse', '--verify', 'HEAD']);
    } catch {
      hasHead = false;
    }

    if (hasHead && changedFile && isInsideConfig(configPath, changedFile)) {
      runGit(configPath, ['add', '--', path.relative(configPath, changedFile)]);
      const gitignore = path.join(configPath, '.gitignore');
      if (fs.existsSync(gitignore)) runGit(configPath, ['add', '--', '.gitignore']);
    } else {
      runGit(configPath, ['add', '-A']);
    }

    const status = runGit(configPath, ['status', '--short']);
    if (!status.trim()) return { ok: true, changed: false };

    runGit(configPath, ['commit', '-m', message || 'Zan config snapshot'], { timeout: 30000 });
    const commit = runGit(configPath, ['rev-parse', '--short', 'HEAD']).trim();
    return { ok: true, changed: true, commit };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function rollbackConfigGit(configPath, ref = 'HEAD~1') {
  const repo = ensureConfigGitRepo(configPath);
  if (!repo.ok) return repo;

  try {
    const target = runGit(configPath, ['rev-parse', '--short', ref]).trim();
    runGit(configPath, ['reset', '--hard', ref], { timeout: 30000 });
    return { ok: true, restored: target };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  ensureConfigGitRepo,
  snapshotConfigGit,
  configGitStatus,
  rollbackConfigGit,
};
