# Helm

Helm sits between coding agents and model providers on this laptop.
`helm wrap claude` or `helm wrap codex` starts a loopback proxy and
points that agent at it. Prompts stay on this machine. Helm Web gets
usage and fingerprint fields only.

Helm Web ([tryhelm.ai](https://tryhelm.ai)) owns the account, team, and
persisted usage. This CLI is the local layer: the live intercept, the
link to that account, transcript reads on this machine, and queued
agent work.

## Installation

One step. macOS, Linux, Windows/WSL — no Node required:

```bash
curl -fsSL https://tryhelm.ai/install | bash
```

That binary includes `helm proxy` and `helm wrap`. Stay in the same
terminal:

```bash
helm wrap claude   # or: helm wrap codex
```

Restart the agent. Undo with `helm unwrap claude` or `helm unwrap
codex`. This is laptop intercept for Claude Code and Codex. It does
not sit on Cursor cloud VMs.

If PATH already runs our CLI (Homebrew on macOS, an older npm global),
the installer replaces that binary so `helm wrap` is the install you
just ran. Kubernetes Helm is never overwritten. A root-owned curl
install is removed with `sudo rm /usr/local/bin/helm`.

Homebrew tap (same binary, same `proxy` / `wrap`):

```bash
brew tap helmai-dev/cli https://github.com/helmai-dev/cli
brew install helmai-dev/cli/helm
```

Or via npm (requires Node.js 18+):

```bash
npm install -g @helmai/cli
```

Also works with `pnpm add -g @helmai/cli` and `bun add -g @helmai/cli`.

**Requirements:** Claude Code and/or Codex on PATH for `helm wrap`.

## Getting started

After install, wrap is enough to sit on the laptop request path. A
Helm Web account is optional for wrap and required to sync usage.

- Register: https://tryhelm.ai/auth/register
- Sign in: https://tryhelm.ai/auth/login

`helm connect` starts the existing device-code flow: it opens
`/auth/device`, you approve while signed in, and a Sanctum token is
stored under `~/.helm` (chmod 600). The token is never printed.

```bash
# Point Claude Code or Codex at the local proxy. Prompts stay here.
helm wrap claude
helm wrap codex

# Local spend report from transcripts on this machine. No account required.
helm audit

# Team rollup from Helm Web after helm connect. People who have scanned.
helm audit --team <team-id>

# Interactive setup: wrap laptop agents, then link / hooks / scan.
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
overlap. If it includes `avoidable_spend` or `diagnose_buckets`, those
print as observed Diagnose. They are stored numbers, not identified
savings. Commands that talk to Helm Web, or that
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
| `helm hooks install` | Install fail-open team-context integrations for supported local coding agents, including the Helm MCP server in Claude Code and Cursor |
| `helm hooks status` | Show each integration, runtime detection, and derived coverage (`--json` for Desktop/automation) |
| `helm hooks uninstall` | Remove only files, hook entries, and Helm MCP registrations managed by Helm |
| `helm mcp` | stdio MCP server that exposes Helm team tools (todos, notes, awareness, live teammates) to local coding agents |
| `helm scan` | Report local Claude Code and Codex usage and sync it to the team dashboard (requires a linked account) |
| `helm audit` | Observed API-equivalent spend from local transcripts, plus realized provider-cache savings. `--team <id>` prints the Helm Web team rollup after `helm connect`. `shared_projects` and `shared_paths` print as observed overlap when the rollup includes them. `avoidable_spend` and `diagnose_buckets` print as observed Diagnose when the rollup includes them. Optional `--users` / `--teams` add an unshared-replay ceiling on the local path. Does not compute identified savings. |
| `helm proxy` | Loopback model proxy on 127.0.0.1 (port 8787 or a free port). Passes Anthropic Messages and OpenAI-compatible chat through with the client's own auth headers. Reuses recent local tool work when project, paths, and tool match. `--daemon` backgrounds it. |
| `helm wrap claude\|codex` | Start the proxy if needed and point that agent at it (`ANTHROPIC_BASE_URL` or Codex/OpenAI base URL). Undo with `helm unwrap`. Does not touch Kubernetes Helm. |
| `helm unwrap claude\|codex` | Restore the agent's previous provider URL |
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
Codex, Cursor, OpenCode, Gemini CLI, GitHub Copilot CLI, Pi, Amp, and Kilo,
and registers a `helm` MCP server in Claude Code (`~/.claude.json`) and Cursor
(`~/.cursor/mcp.json`) that launches `helm mcp`. Grok Code reads the Claude
Code hooks through its compatibility layer, so Helm reports Grok as derived
coverage and does not install a duplicate hook.

The integration files fail open: a missing, disconnected, or slow Helm CLI does
not prevent an agent session from running. Existing unrelated hooks, MCP
servers, and settings are preserved, and standalone plugin files are overwritten
only when they carry Helm's ownership marker. `helm logout` and
`helm hooks uninstall` remove only the Helm MCP entry. Run `helm hooks status`
to inspect the exact paths.

`helm mcp` is a local stdio server. Coding agents host it; it authenticates with
the existing `helm connect` token and forwards the web MCP tools the user can
already call, plus a live-teammates read of path/project overlap. Prompt text
stays on this machine. An unlinked CLI still advertises the tools and tells the
agent to run `helm connect`. This is not an HTTP proxy and does not start
agent-to-agent chat.

For agents that expose turn lifecycle hooks, Helm uses the submitted prompt to
retrieve a small relevant team-context pack before work begins. It then retains
bounded, sanitized tool evidence locally and submits a deduplicated learning
candidate when the turn completes. Candidates require an explicit team-admin
review before they become shared Context Memory; rejected candidates never enter
retrieval. Repository remotes are matched automatically, so normal usage does not
require `helm map` or another per-project CLI step.

`helm wrap claude` or `helm wrap codex` starts `helm proxy` if needed and
points that agent at it. Claude Code honors `ANTHROPIC_BASE_URL` in
`~/.claude/settings.json`. Codex honors the OpenAI-compatible `base_url` in
`~/.codex/config.toml`. `helm unwrap` restores the previous value. The
proxy forwards the client's own provider tokens; Helm does not need those
keys. On each request it can see the prompt locally, then POST only the
existing usage and fingerprint fields. Prompt text never goes to Helm Web.
Identified savings stay null. `helm wrap` only accepts `claude` and `codex`.

This is shared-work reuse, not model routing and not prompt caching. After a
successful proxied request, the proxy stores a local work record in
`~/.helm/environments/<env>/proxy-work.json` (project, path hints, tools,
session key, stored cost and tokens, and tool results already present on
that request). Prompts are not written there. Before the next forward, a
hit is the same project, an overlapping path set, the same tool, and an
age under 24 hours. On a hit with stored tool results, the proxy reuses
those bytes, skips the provider for that tool work, and attributes avoided
dollars only as the stored `cost_usd` of the original request. A miss or a
record with no payload still forwards. Other laptops and prompt-shaped
completions are not reused yet. Team-wide byte reuse needs a later web
blob store. Every wrapped request injects `Helm is wrapping this request.`
into the harness. A reuse also prints a louder line that Helm reused prior
work and did not send that tool work to the provider.

When this machine is linked, the tool hook also sends a work fingerprint for
each tool call in a mapped Claude Code or Codex session: the provider, the
project folder name, a project-relative file or folder when the tool call
already named one, the tool name, and the event time. That is the whole
payload. Prompts, file contents, command lines, tool output, and diffs never
leave this machine. Fingerprints let the team see that work happened in the
same project or file. They are labels, not savings, and they measure nothing
about cost. If Helm Web is slow or unreachable, the send is dropped after 1.2
seconds and the session continues; unlinked machines send nothing. A 2xx
`others` list becomes one short hook notice naming the person, the path
or project, and how recently they were there. Missing or empty `others`
stays silent.

On UserPromptSubmit, a linked session also GETs live overlap for this
project folder and any project-relative path extracted locally from the
prompt. The prompt itself is not uploaded. If a teammate matches, Helm
adds one short notice on the same hook channel as the context pack
("Alex was on Foo.php 3 minutes ago") before the model call. A missing
or failing live endpoint is ignored.

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
