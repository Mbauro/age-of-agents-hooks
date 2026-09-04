#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { installHooks, uninstallHooks } = require('../lib/config');
const { heartbeatLoop, runHook } = require('../lib/bridge');
const pkg = require('../package.json');

function parseOptions(args) {
  const options = { positional: [] };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('--')) options.positional.push(arg);
    else if (arg === '--purge') options.purge = true;
    else {
      const key = arg.slice(2);
      if (!['url', 'pairing-code', 'device-name', 'home', 'command-path'].includes(key)) {
        throw new Error(`Unknown option: ${arg}`);
      }
      options[key] = args[++index];
      if (!options[key]) throw new Error(`Missing value for ${arg}.`);
    }
  }
  return options;
}

function validateUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Server URL must be an absolute HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Server URL must use HTTP or HTTPS.');
  const loopback = ['localhost', '::1', '[::1]'].includes(url.hostname) || /^127\./.test(url.hostname);
  if (url.protocol === 'http:' && !loopback && process.env.AGE_OF_AGENTS_ALLOW_INSECURE !== '1') {
    throw new Error('Remote servers must use HTTPS.');
  }
  if (url.username || url.password || url.search) throw new Error('Server URL must not contain credentials or a query string.');
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

async function promptFor(missingUrl, missingCode) {
  if ((!missingUrl && !missingCode) || !stdin.isTTY) return {};
  const prompt = readline.createInterface({ input: stdin, output: stdout });
  try {
    const result = {};
    if (missingUrl) result.url = await prompt.question('Age of Agents server URL [http://localhost:8765]: ');
    if (missingCode) result.code = await prompt.question('One-time pairing code: ');
    return result;
  } finally {
    prompt.close();
  }
}

async function install(options) {
  const answers = await promptFor(!options.url, !options['pairing-code']);
  const url = validateUrl(options.url || answers.url || 'http://localhost:8765');
  const code = options['pairing-code'] || answers.code;
  if (!/^\d{6}$/.test(code || '')) throw new Error('Pairing code must contain six digits.');
  const deviceName = options['device-name'] || os.hostname() || 'Agent device';
  const response = await fetch(`${url}/api/agent-devices/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, name: deviceName }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('Pairing failed or the code expired.');
  const pairing = await response.json();
  if (!pairing.token) throw new Error('Pairing response did not contain a device token.');

  const homeDir = path.resolve(options.home || os.homedir());
  const command = options['command-path'] || process.env.AGE_OF_AGENTS_COMMAND || path.resolve(process.argv[1]);
  const targets = installHooks({ homeDir, command, url, token: pairing.token, deviceId: pairing.deviceId });
  console.log('Age of Agents hooks installed:');
  for (const [agent, target] of Object.entries(targets)) console.log(`  ${agent}: ${target}`);
  console.log('Restart active coding agents. In Codex, run /hooks and trust the new hooks.');
}

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  const options = parseOptions(args);
  if (command === 'version' || command === '--version') return console.log(pkg.version);
  if (command === 'validate-url') return console.log(validateUrl(options.positional[0] || ''));
  if (command === 'install') return install(options);
  if (command === 'check') {
    const homeDir = path.resolve(options.home || os.homedir());
    await runHook({ action: 'check', source: 'manual', explicitId: 'connection-check', input: '',
      homeDir, scriptPath: path.resolve(process.argv[1]) });
    console.log(`Age of Agents connection OK: ${require('../lib/bridge').loadConfig(homeDir).url}`);
    return;
  }
  if (command === 'uninstall') {
    uninstallHooks({ homeDir: path.resolve(options.home || os.homedir()), purge: options.purge });
    console.log(`Age of Agents hooks removed${options.purge ? ' and local credentials deleted' : ''}.`);
    return;
  }
  if (command === 'hook') {
    const [action, source = 'agent', explicitId, ownerPid, pidFile] = options.positional;
    const homeDir = path.resolve(options.home || os.homedir());
    if (action === 'heartbeat-loop') {
      return heartbeatLoop({ homeDir, source, clientId: explicitId || 'default', ownerPid: Number(ownerPid), pidFile });
    }
    let input = '';
    if (!stdin.isTTY) {
      try { input = fs.readFileSync(0, 'utf8'); } catch {}
    }
    try {
      await runHook({ action, source, explicitId, input, homeDir, scriptPath: path.resolve(process.argv[1]) });
      if (action === 'check') console.log(`Age of Agents connection OK: ${require('../lib/bridge').loadConfig(homeDir).url}`);
    } catch (error) {
      if (action === 'check') throw error;
    }
    if (action !== 'check') console.log('{"continue":true}');
    return;
  }
  console.log('Usage: age-of-agents-hooks <install|check|uninstall|version>');
  console.log('  install [--url URL] [--pairing-code CODE] [--device-name NAME]');
  console.log('  uninstall [--purge]');
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
