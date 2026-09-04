'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function pathsFor(homeDir) {
  const root = path.join(homeDir, '.age-of-agents');
  return { root, config: path.join(root, 'config.json'), runtime: path.join(root, 'runtime') };
}

function loadConfig(homeDir) {
  const { config } = pathsFor(homeDir);
  if (!fs.existsSync(config)) throw new Error('Age of Agents hooks are not configured. Run: age-of-agents-hooks install');
  const value = JSON.parse(fs.readFileSync(config, 'utf8'));
  if (!value.url || !value.token) throw new Error('Age of Agents hook configuration is incomplete.');
  return value;
}

function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, '_');
}

async function postEvent(config, endpoint, source, clientId) {
  const response = await fetch(`${config.url}/agent/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
    body: JSON.stringify({ source, clientId }),
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error(`Age of Agents returned HTTP ${response.status}.`);
}

function clientIdFromInput(explicitId, input) {
  if (explicitId) return explicitId;
  let data = {};
  try { data = input ? JSON.parse(input) : {}; } catch {}
  const keys = ['session_id', 'sessionId', 'conversation_id', 'conversationId', 'thread_id', 'thread-id', 'threadId'];
  return String(keys.map((key) => data[key]).find(Boolean) || 'default');
}

function pidFileFor(homeDir, source, clientId) {
  return path.join(pathsFor(homeDir).runtime, `${safeName(`${source}-${clientId}`)}.json`);
}

async function heartbeatLoop({ homeDir, source, clientId, ownerPid, pidFile }) {
  const config = loadConfig(homeDir);
  let stopping = false;
  const cleanup = async () => {
    if (stopping) return;
    stopping = true;
    try { await postEvent(config, 'stop', source, clientId); } catch {}
    try { fs.unlinkSync(pidFile); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  const heartbeatSeconds = Math.max(5, Number(process.env.AGE_OF_AGENTS_HEARTBEAT_SECONDS) || 15);
  for (;;) {
    try { process.kill(ownerPid, 0); } catch { return cleanup(); }
    try { await postEvent(config, 'heartbeat', source, clientId); } catch {}
    await new Promise((resolve) => setTimeout(resolve, heartbeatSeconds * 1000));
  }
}

function findPidFiles(homeDir, source, clientId) {
  const { runtime } = pathsFor(homeDir);
  if (!fs.existsSync(runtime)) return [];
  if (clientId !== 'default') return [pidFileFor(homeDir, source, clientId)].filter(fs.existsSync);
  const prefix = `${safeName(`${source}-`)}`;
  return fs.readdirSync(runtime)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .map((name) => path.join(runtime, name));
}

async function runHook({ action, source, explicitId, input, homeDir, scriptPath }) {
  if (action === 'heartbeat-loop') throw new Error('heartbeat-loop must be invoked internally.');
  const config = loadConfig(homeDir);
  const clientId = clientIdFromInput(explicitId, input);
  const { runtime } = pathsFor(homeDir);
  fs.mkdirSync(runtime, { recursive: true });

  if (action === 'start') {
    try { await postEvent(config, 'start', source, clientId); } catch {}
    const pidFile = pidFileFor(homeDir, source, clientId);
    let running = false;
    try {
      const existing = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
      process.kill(existing.pid, 0);
      running = true;
    } catch {}
    if (!running) {
      const child = spawn(process.execPath, [scriptPath, 'hook', 'heartbeat-loop', source, clientId,
        String(process.ppid), pidFile], { detached: true, stdio: 'ignore', env: process.env });
      fs.writeFileSync(pidFile, `${JSON.stringify({ pid: child.pid, clientId })}\n`, { mode: 0o600 });
      child.unref();
    }
  } else if (action === 'stop') {
    for (const pidFile of findPidFiles(homeDir, source, clientId)) {
      try {
        const saved = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
        process.kill(saved.pid, 'SIGTERM');
      } catch {}
      try { fs.unlinkSync(pidFile); } catch {}
    }
    try { await postEvent(config, 'stop', source, clientId); } catch {}
  } else if (action === 'check') {
    await postEvent(config, 'start', source, clientId);
    await postEvent(config, 'stop', source, clientId);
  } else {
    throw new Error(`Unknown hook action: ${action}`);
  }
}

module.exports = { heartbeatLoop, loadConfig, postEvent, runHook };
