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
# 1. Connect this machine (opens a browser approval on any device).
#    Defaults to https://tryhelm.ai — pass --url for a self-hosted backend.
helm connect

# 2. Register local checkouts for the projects this machine should run
helm map <project-id> ~/code/my-project

# 3. Start the daemon
helm daemon start

# 4. (Recommended) Keep it running across reboots and logouts
helm daemon install
```

The machine now appears in Helm's "Run agents on" picker for you and your
teammates. Queued agent starts are claimed within seconds, run locally,
and their output streams back into the Helm canvas.

## Commands

| Command | Description |
|---|---|
| `helm connect` | Connect this machine to a helm-web backend (device-code auth) |
| `helm map <project-id> [path]` | Register a local checkout for a project |
| `helm daemon start` | Start the background agent-runner daemon (`--foreground` runs it in-process for supervisors) |
| `helm daemon stop` | Stop the daemon |
| `helm daemon install` | Keep the daemon running across reboots (launchd on macOS, systemd user unit on Linux, scheduled task on Windows) |
| `helm daemon uninstall` | Remove the reboot-persistence unit |
| `helm daemon status` | Show daemon state, auth state, persistence, and recent log lines |
| `helm daemon info` | Show live runs and stats |
| `helm logout` | Clear credentials for the active environment |
| `helm update` | Update to the latest version |

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
