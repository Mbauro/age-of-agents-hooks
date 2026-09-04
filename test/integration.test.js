'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const cli = path.join(__dirname, '..', 'bin', 'age-of-agents-hooks.js');

function run(args) {
  return new Promise((resolve) => {
    const child = childProcess.spawn(process.execPath, [cli, ...args], { encoding: 'utf8' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('pairs, stores the token privately, and checks the connection', async (context) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push({ url: request.url, authorization: request.headers.authorization, body });
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/api/agent-devices/claim') {
        response.end(JSON.stringify({ deviceId: 'device-test', token: 'token-test' }));
      } else {
        response.end(JSON.stringify({ status: 'ok' }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());

  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'age-of-agents-cli-'));
  const url = `http://127.0.0.1:${server.address().port}`;
  const installed = await run(['install', '--url', url, '--pairing-code', '123456', '--home', homeDir,
    '--command-path', '/usr/local/bin/age-of-agents-hooks']);
  assert.equal(installed.status, 0, installed.stderr);
  assert.doesNotMatch(installed.stdout, /token-test/);

  const configPath = path.join(homeDir, '.age-of-agents', 'config.json');
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).token, 'token-test');

  const checked = await run(['check', '--home', homeDir]);
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /connection OK/);
  assert.equal(requests.filter((request) => request.url === '/agent/start').length, 1);
  assert.equal(requests.filter((request) => request.url === '/agent/stop').length, 1);
  assert.equal(requests.find((request) => request.url === '/agent/start').authorization, 'Bearer token-test');
});
