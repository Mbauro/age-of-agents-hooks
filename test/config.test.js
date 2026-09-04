'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const test = require('node:test');
const { installHooks, uninstallHooks } = require('../lib/config');

test('installs idempotently and preserves unrelated hooks', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'age-of-agents-hooks-'));
  const claudePath = path.join(homeDir, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(claudePath), { recursive: true });
  fs.writeFileSync(claudePath, JSON.stringify({ theme: 'dark', hooks: {
    PreToolUse: [{ hooks: [{ type: 'command', command: '/usr/local/bin/unrelated' }] }],
  } }));

  const input = { homeDir, command: '/opt/homebrew/opt/age-of-agents-hooks/bin/age-of-agents-hooks',
    url: 'https://example.invalid', token: 'test-token', deviceId: 'test-device' };
  installHooks(input);
  installHooks(input);

  const claude = JSON.parse(fs.readFileSync(claudePath, 'utf8'));
  assert.equal(claude.theme, 'dark');
  assert.equal(claude.hooks.PreToolUse[0].hooks[0].command, '/usr/local/bin/unrelated');
  assert.equal(claude.hooks.UserPromptSubmit.length, 1);
  assert.match(claude.hooks.UserPromptSubmit[0].hooks[0].command, /age-of-agents-hooks/);
  const stored = JSON.parse(fs.readFileSync(path.join(homeDir, '.age-of-agents', 'config.json'), 'utf8'));
  assert.equal(stored.token, 'test-token');
  assert.equal(fs.statSync(path.join(homeDir, '.age-of-agents', 'config.json')).mode & 0o777, 0o600);
  const plugin = path.join(homeDir, '.config', 'opencode', 'plugins', 'age-of-agents.js');
  assert.equal(childProcess.spawnSync(process.execPath, ['--check', plugin]).status, 0);
});

test('uninstall removes only managed hooks and optionally purges credentials', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'age-of-agents-hooks-'));
  installHooks({ homeDir, command: '/usr/local/bin/age-of-agents-hooks',
    url: 'https://example.invalid', token: 'test-token', deviceId: 'test-device' });
  uninstallHooks({ homeDir, purge: true });

  const claude = JSON.parse(fs.readFileSync(path.join(homeDir, '.claude', 'settings.json'), 'utf8'));
  assert.equal(claude.hooks.UserPromptSubmit, undefined);
  assert.equal(fs.existsSync(path.join(homeDir, '.config', 'opencode', 'plugins', 'age-of-agents.js')), false);
  assert.equal(fs.existsSync(path.join(homeDir, '.age-of-agents')), false);
});
