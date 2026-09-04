'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DESCRIPTION = 'Age of Agents presence lifecycle';
const COMMAND_MARKER = 'age-of-agents-hooks';

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot parse ${filePath}: ${error.message}`);
  }
}

function isOurs(entry) {
  return Boolean(entry && typeof entry.command === 'string' && entry.command.includes(COMMAND_MARKER));
}

function cleanLifecycleGroups(groups) {
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((group) => {
    if (!group || typeof group !== 'object' || isOurs(group)) return [];
    if (!Array.isArray(group.hooks)) return [group];
    const hooks = group.hooks.filter((handler) => !isOurs(handler));
    return hooks.length ? [{ ...group, hooks }] : [];
  });
}

function normalizeLifecycle(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) config = {};
  if (Array.isArray(config.hooks)) {
    const converted = {};
    for (const oldHook of config.hooks) {
      if (!oldHook || typeof oldHook.event !== 'string' || isOurs(oldHook)) continue;
      if (!converted[oldHook.event]) converted[oldHook.event] = [];
      const { event, ...handler } = oldHook;
      converted[oldHook.event].push({ hooks: [{ type: 'command', ...handler }] });
    }
    config.hooks = converted;
  }
  if (!config.hooks || typeof config.hooks !== 'object') config.hooks = {};
  return config;
}

function cleanLifecycle(config) {
  config = normalizeLifecycle(config);
  for (const event of Object.keys(config.hooks)) {
    config.hooks[event] = cleanLifecycleGroups(config.hooks[event]);
    if (!config.hooks[event].length) delete config.hooks[event];
  }
  if (config.description === DESCRIPTION) delete config.description;
  return config;
}

function normalizeCursor(config) {
  if (Array.isArray(config)) {
    const hooks = {};
    for (const oldHook of config) {
      if (!oldHook || typeof oldHook.event !== 'string' || isOurs(oldHook)) continue;
      if (!hooks[oldHook.event]) hooks[oldHook.event] = [];
      const { event, ...handler } = oldHook;
      hooks[oldHook.event].push(handler);
    }
    return { version: 1, hooks };
  }
  if (!config || typeof config !== 'object') config = {};
  if (!config.hooks || typeof config.hooks !== 'object') config.hooks = {};
  return config;
}

function cleanCursor(config) {
  config = normalizeCursor(config);
  for (const event of Object.keys(config.hooks)) {
    const handlers = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
    config.hooks[event] = handlers.filter((handler) => !isOurs(handler));
    if (!config.hooks[event].length) delete config.hooks[event];
  }
  return config;
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.age-of-agents.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

function backupOnce(filePath) {
  if (!fs.existsSync(filePath)) return;
  const backupPath = `${filePath}.age-of-agents.backup`;
  if (!fs.existsSync(backupPath)) fs.copyFileSync(filePath, backupPath);
}

function quoteCommand(commandPath) {
  return `"${commandPath.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function lifecycleTemplate(command, source, includeFailure) {
  const handler = (action, timeout) => ({
    hooks: [{
      type: 'command',
      command: `${quoteCommand(command)} hook ${action} ${source}`,
      ...(timeout ? { timeout } : {}),
    }],
  });
  const hooks = {
    UserPromptSubmit: [handler('start')],
    Stop: [handler('stop')],
    SessionEnd: [handler('stop', 3)],
  };
  if (includeFailure) hooks.StopFailure = [handler('stop')];
  return hooks;
}

function cursorTemplate(command) {
  const handler = (action) => ({ command: `${quoteCommand(command)} hook ${action} cursor` });
  return {
    beforeSubmitPrompt: [handler('start')],
    stop: [handler('stop')],
    sessionEnd: [handler('stop')],
  };
}

function targetsFor(homeDir) {
  return {
    claude: path.join(homeDir, '.claude', 'settings.json'),
    cursor: path.join(homeDir, '.cursor', 'hooks.json'),
    codex: path.join(homeDir, '.codex', 'hooks.json'),
    opencode: path.join(homeDir, '.config', 'opencode', 'plugins', 'age-of-agents.js'),
  };
}

function installHooks({ homeDir, command, url, token, deviceId }) {
  const targets = targetsFor(homeDir);
  const lifecycle = [
    [targets.claude, 'claude', true],
    [targets.codex, 'codex', false],
  ];
  for (const [target, source, includeFailure] of lifecycle) {
    backupOnce(target);
    const config = cleanLifecycle(readJson(target, {}));
    config.hooks = { ...config.hooks, ...Object.fromEntries(
      Object.entries(lifecycleTemplate(command, source, includeFailure)).map(([event, groups]) => [
        event, [...(config.hooks[event] || []), ...groups],
      ])
    ) };
    if (!config.description) config.description = DESCRIPTION;
    atomicWriteJson(target, config);
  }

  backupOnce(targets.cursor);
  const cursor = cleanCursor(readJson(targets.cursor, { version: 1, hooks: {} }));
  for (const [event, handlers] of Object.entries(cursorTemplate(command))) {
    cursor.hooks[event] = [...(cursor.hooks[event] || []), ...handlers];
  }
  cursor.version ||= 1;
  atomicWriteJson(targets.cursor, cursor);

  backupOnce(targets.opencode);
  fs.mkdirSync(path.dirname(targets.opencode), { recursive: true });
  const cli = JSON.stringify(command);
  fs.writeFileSync(targets.opencode, `// Managed by age-of-agents-hooks.\nexport const AgeOfAgentsPlugin = async ({ $ }) => {\n  const cli = ${cli}\n  const signal = async (action, sessionID) => {\n    try {\n      await \$\`${'${cli}'} hook ${'${action}'} opencode ${'${sessionID || "default"}'}\`\n    } catch {\n      // Presence reporting must never interfere with OpenCode.\n    }\n  }\n  return {\n    event: async ({ event }) => {\n      const properties = event.properties || {}\n      const sessionID = properties.sessionID || properties.info?.id || "default"\n      const status = properties.status?.type || properties.status\n      if (event.type === "session.status" && status === "busy") {\n        await signal("start", sessionID)\n      } else if (event.type === "session.idle" || event.type === "session.error" ||\n        event.type === "session.deleted" || (event.type === "session.status" && status === "idle")) {\n        await signal("stop", sessionID)\n      }\n    },\n  }\n}\n`, { mode: 0o600 });

  atomicWriteJson(path.join(homeDir, '.age-of-agents', 'config.json'), { url, token, deviceId });
  return targets;
}

function uninstallHooks({ homeDir, purge = false }) {
  const targets = targetsFor(homeDir);
  for (const target of [targets.claude, targets.codex]) {
    if (fs.existsSync(target)) atomicWriteJson(target, cleanLifecycle(readJson(target, {})));
  }
  if (fs.existsSync(targets.cursor)) atomicWriteJson(targets.cursor, cleanCursor(readJson(targets.cursor, {})));
  if (fs.existsSync(targets.opencode)) {
    const contents = fs.readFileSync(targets.opencode, 'utf8');
    if (contents.includes('Managed by age-of-agents-hooks')) fs.unlinkSync(targets.opencode);
  }
  if (purge) fs.rmSync(path.join(homeDir, '.age-of-agents'), { recursive: true, force: true });
  return targets;
}

module.exports = { cleanCursor, cleanLifecycle, installHooks, isOurs, readJson, uninstallHooks };
