# Helm Daemon

Run Helm agents on this machine, controlled from Helm.

Install this on any always-on machine — a desktop at home, an office
workstation, a home server — and it becomes a run target for your Helm
team: agent sessions started from the Helm desktop app (or the web) are
queued to this machine's daemon, executed here with Claude Code or Codex,
and streamed back live.

Helm Web ([tryhelm.ai](https://tryhelm.ai)) owns the account, team, and
persisted usage. This CLI is the local layer: it links to that account,
reads transcripts on this machine, and runs queued agent work.

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

Create a Helm Web account first (or sign in if you already have one):

- Register: https://tryhelm.ai/auth/register
- Sign in: https://tryhelm.ai/auth/login

Then link this CLI to that account. `helm connect` starts the existing
device-code flow: it opens `/auth/device`, you approve while signed in,
and a Sanctum token is stored under `~/.helm` (chmod 600). The token is
never printed.

```bash
# Local spend report from transcripts on this machine. No account required.
helm audit

# Team rollup from Helm Web after helm connect. People who have scanned.
helm audit --team <team-id>

# Interactive setup: link the account, install coding-agent integrations, and scan usage.
helm setup

# Or link this machine on its own
helm connect

# Confirm the link (never prints a token)
helm whoami

# Register local checkouts for projects this machine should run
helm map <project-id> ~/code/my-project

# Start the daemon
helm daemon start

# (Recommended) Keep it running across reboots and logouts
helm daemon install
```

`helm audit` without `--team` is local. It reads Claude Code and Codex
transcripts on this machine and does not need a Helm Web account.
`helm audit --team <id>` prints the same team usage rollup the `/usage`
page shows and refuses until the CLI is linked. If that rollup includes
`shared_projects` or `shared_paths`, those sections print as observed
overlap. They are not savings. Commands that talk to Helm Web, or that
sync team usage (`helm scan`, `helm map`, `helm daemon start`), refuse
until the CLI is linked. They print the register/login URLs and
`helm connect` as the next step. `helm scan --no-upload` still prints a
local report without an account. Session-end `helm scan --quiet` fails
open so a missing account never breaks a coding-agent session.

The machine now appears in Helm's "Run agents on" picker for you and your
teammates. Queued agent starts are claimed within seconds, run locally,
and their output streams back into the Helm canvas.

## Commands

| Command | Description |
|---|---|
| `helm setup` | Link the Helm Web account, enable team context in supported coding agents, and run the first usage scan |
| `helm connect` | Link this CLI to a Helm Web account (device-code auth) |
| `helm whoami` | Show which account and machine this CLI is linked as (never prints a token) |
| `helm hooks install` | Install fail-open team-context integrations for supported local coding agents |
| `helm hooks status` | Show each integration, runtime detection, and derived coverage (`--json` for Desktop/automation) |
| `helm hooks uninstall` | Remove only files and hook entries managed by Helm |
| `helm scan` | Report local Claude Code and Codex usage and sync it to the team dashboard (requires a linked account) |
| `helm audit` | Observed API-equivalent spend from local transcripts, plus realized provider-cache savings. `--team <id>` prints the Helm Web team rollup after `helm connect`. `shared_projects` and `shared_paths` print as observed overlap when the rollup includes them. Optional `--users` / `--teams` add an unshared-replay ceiling on the local path. Does not compute identified savings. |
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

When this machine is linked, the tool hook also sends a work fingerprint for
each tool call in a mapped Claude Code or Codex session: the provider, the
project folder name, a project-relative file or folder when the tool call
already named one, the tool name, and the event time. That is the whole
payload. Prompts, file contents, command lines, tool output, and diffs never
leave this machine. Fingerprints let the team see that work happened in the
same project or file. They are labels, not savings, and they measure nothing
about cost. If Helm Web is slow or unreachable, the send is dropped after 1.2
seconds and the session continues; unlinked machines send nothing.

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
