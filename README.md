# Helm Daemon

Run Helm agents on this machine, controlled from Helm.

Install this on any always-on machine — a desktop at home, an office
workstation, a home server — and it becomes a run target for your Helm
team: agent sessions started from the Helm desktop app (or the web) are
queued to this machine's daemon, executed here with Claude Code or Codex,
and streamed back live.

The [Helm desktop app](https://tryhelm.ai) is the product. This CLI is the
headless runner for machines that don't need the full app.

## Installation

Standalone binary (macOS, Linux, Windows/WSL — no Node required):

```bash
curl -fsSL https://tryhelm.ai/install | bash
```

Or via a package manager (requires Node.js 18+):

```bash
npm install -g @helmai/cli
```

Also works with `pnpm add -g @helmai/cli` and `bun add -g @helmai/cli`.

**Requirements:** the agent CLIs you want this machine to offer
(`claude` and/or `codex` on PATH).

## Getting started

```bash
# Interactive setup: connect, install coding-agent integrations, and scan usage.
helm setup

# Register local checkouts for projects this machine should run
helm map <project-id> ~/code/my-project

# Start the daemon
helm daemon start

# (Recommended) Keep it running across reboots and logouts
helm daemon install
```

The machine now appears in Helm's "Run agents on" picker for you and your
teammates. Queued agent starts are claimed within seconds, run locally,
and their output streams back into the Helm canvas.

## Commands

| Command | Description |
|---|---|
| `helm setup` | Connect, enable team context in supported coding agents, and run the first usage scan |
| `helm connect` | Connect this machine to a helm-web backend (device-code auth) |
| `helm hooks install` | Install fail-open team-context integrations for supported local coding agents |
| `helm hooks status` | Show each integration, runtime detection, and derived coverage (`--json` for Desktop/automation) |
| `helm hooks uninstall` | Remove only files and hook entries managed by Helm |
| `helm scan` | Report local Claude Code and Codex usage and sync it to the team dashboard |
| `helm audit` | Observed API-equivalent spend from local transcripts, plus realized provider-cache savings. Optional `--users` / `--teams` add an unshared-replay scenario. Does not compute identified savings. |
| `helm map <project-id> [path]` | Register a local checkout for a project |
| `helm daemon start` | Start the background agent-runner daemon (`--foreground` runs it in-process for supervisors) |
| `helm daemon stop` | Stop the daemon |
| `helm daemon install` | Keep the daemon running across reboots (launchd on macOS, systemd user unit on Linux, scheduled task on Windows) |
| `helm daemon uninstall` | Remove the reboot-persistence unit |
| `helm daemon status` | Show daemon state, auth state, persistence, and recent log lines |
| `helm daemon info` | Show live runs and stats |
| `helm logout` | Clear credentials for the active environment |
| `helm update` | Update to the latest version |

## Coding-agent integrations

`helm setup` calls `helm hooks install`. It currently configures Claude Code,
Codex, Cursor, OpenCode, Gemini CLI, GitHub Copilot CLI, Pi, Amp, and Kilo.
Grok Code reads the Claude Code hooks through its compatibility layer, so Helm
reports Grok as derived coverage and does not install a duplicate hook.

The integration files fail open: a missing, disconnected, or slow Helm CLI does
not prevent an agent session from running. Existing unrelated hooks and settings
are preserved, and standalone plugin files are overwritten only when they carry
Helm's ownership marker. Run `helm hooks status` to inspect the exact paths.

For agents that expose turn lifecycle hooks, Helm uses the submitted prompt to
retrieve a small relevant team-context pack before work begins. It then retains
bounded, sanitized tool evidence locally and submits a deduplicated learning
candidate when the turn completes. Candidates require an explicit team-admin
review before they become shared Context Memory; rejected candidates never enter
retrieval. Repository remotes are matched automatically, so normal usage does not
require `helm map` or another per-project CLI step.

## How it works

The daemon heartbeats into Helm's device registry every 30 seconds
(advertising which agent runtimes are installed) and claims queued work
every 3 seconds. Claimed `agent.start` packages run through the Claude
Agent SDK or Codex SDK in the mapped project checkout; output relays to
Helm as live session chunks, and lifecycle events (started, completed,
failed) report back onto the work package. Work this machine can't run —
an unmapped project, a missing runtime — fails loudly and immediately so
nothing ever hangs "claimed".

State lives in `~/.helm/environments/<env>/` (credentials are chmod 600).
The daemon log is `~/.helm/environments/<env>/daemon.log` (rotated to
`daemon.log.1` at ~5MB on daemon start).

## Surviving reboots

`helm daemon start` alone does not survive a reboot or logout. Run
`helm daemon install` once and the daemon is supervised by the OS:

- **macOS** — a launchd LaunchAgent at
  `~/Library/LaunchAgents/ai.tryhelm.daemon.<env>.plist` (RunAtLoad +
  KeepAlive: starts at login, restarts if it dies).
- **Linux** — a systemd user unit at
  `~/.config/systemd/user/helm-daemon-<env>.service` (`Restart=always`).
  Run `loginctl enable-linger` so it also runs while you're logged out.
- **Windows** — a Scheduled Task (`HelmDaemon-<env>`) that starts the
  daemon at logon (no supervision if it later dies).

`helm daemon status` shows whether a persistence unit is installed;
`helm daemon uninstall` removes it cleanly.
