'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const cli = path.join(__dirname, '..', 'bin', 'age-of-agents-hooks.js');

test('prints its version', () => {
  const result = childProcess.spawnSync(process.execPath, [cli, 'version'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '1.0.0');
});

test('accepts HTTPS and loopback HTTP URLs', () => {
  for (const url of ['https://example.invalid/', 'http://localhost:8765/']) {
    const result = childProcess.spawnSync(process.execPath, [cli, 'validate-url', url], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), url.replace(/\/$/, ''));
  }
});

test('rejects remote HTTP URLs', () => {
  const result = childProcess.spawnSync(process.execPath, [cli, 'validate-url', 'http://example.invalid'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must use HTTPS/);
});
