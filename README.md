# Age of Agents Hooks

Lifecycle hooks that connect Claude Code, Cursor, Codex, and OpenCode sessions
to an Age of Agents server.

## Install

```bash
brew install Mbauro/tap/age-of-agents-hooks
age-of-agents-hooks install
```

Open Age of Agents, create a one-time pairing code, and enter it when prompted.
Remote servers must use HTTPS. The resulting device credential is stored only
on your computer in `~/.age-of-agents/config.json` with owner-only permissions.

Restart active coding agents after installation. Codex also requires running
`/hooks` once and trusting the Age of Agents hooks.

For unattended setup, the same values can be supplied explicitly:

```bash
age-of-agents-hooks install \
  --url https://your-age-of-agents-server.example \
  --pairing-code 123456
```

Pairing codes are short-lived and single-use. Avoid placing them in persistent
shell history when interactive setup is available.

## Remove

Remove managed hook entries while retaining the local device credential:

```bash
age-of-agents-hooks uninstall
```

Remove managed hooks and local credentials before uninstalling the formula:

```bash
age-of-agents-hooks uninstall --purge
brew uninstall age-of-agents-hooks
```

Revoking the paired device in the Age of Agents web interface invalidates its
credential on the server.

## Security

The installer preserves unrelated agent configuration and creates one-time
backups before its first modification. Device tokens are never printed, passed
as process arguments, or written to logs. Presence requests have short timeouts
and hook delivery failures never interrupt the coding agent.
