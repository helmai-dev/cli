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

```bash
npm install -g @helmai/cli
```

Also works with `pnpm add -g @helmai/cli` and `bun add -g @helmai/cli`.

**Requirements:** Node.js 18+, plus the agent CLIs you want this machine
to offer (`claude` and/or `codex` on PATH).

## Getting started

```bash
# 1. Connect this machine (opens a browser approval on any device)
helm connect --url https://your-helm-web-host

# 2. Register local checkouts for the projects this machine should run
helm map <project-id> ~/code/my-project

# 3. Start the daemon
helm daemon start
```

The machine now appears in Helm's "Run agents on" picker for you and your
teammates. Queued agent starts are claimed within seconds, run locally,
and their output streams back into the Helm canvas.

## Commands

| Command | Description |
|---|---|
| `helm connect` | Connect this machine to a helm-web backend (device-code auth) |
| `helm map <project-id> [path]` | Register a local checkout for a project |
| `helm daemon start` | Start the background agent-runner daemon |
| `helm daemon stop` | Stop the daemon |
| `helm daemon status` | Show daemon state and recent log lines |
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
