# Helm CLI

Intelligent context injection for AI coding assistants.

Helm hooks into Claude Code and Cursor to automatically inject your project rules, knowledge, and team context into every prompt — without you having to think about it.

## Installation

```bash
curl -fsSL https://tryhelm.ai/install | bash
```

Or via npm:

```bash
npm install -g @helmai/cli
```

**Requirements:** macOS or Linux (arm64 / x64), Node.js 18+

## Getting Started

```bash
helm init
```

This detects your IDE, installs the prompt hooks, and optionally connects to [Helm Cloud](https://tryhelm.ai) for team rule sync.

## Commands

### Core

| Command | Description |
|---|---|
| `helm init` | Set up Helm in your project or globally |
| `helm status` | Show current config, detected IDEs, and stack |
| `helm dashboard` | Open the Helm Cloud dashboard |
| `helm update` | Update to the latest version |
| `helm logout` | Clear saved credentials |

### Rules & Knowledge

| Command | Description |
|---|---|
| `helm rule add <text>` | Add a rule to `.helm/rules.md` |
| `helm save [title]` | Save a knowledge snippet for context injection |
| `helm sync` | Pull rules from Helm Cloud |
| `helm sync --push` | Push local rules to Helm Cloud |
| `helm link` | Link this project to Helm Cloud |

### MCPs

| Command | Description |
|---|---|
| `helm mcps` | Show MCP status |
| `helm mcps list` | Browse the full MCP catalog |
| `helm mcps install <name>` | Install an MCP |
| `helm mcps remove <name>` | Remove an MCP |
| `helm mcps configure <name>` | Set API key / config for an MCP |

### Other

| Command | Description |
|---|---|
| `helm qc` | Run quality checks on staged files |
| `helm clean` | Remove Helm hooks and config traces |
| `helm skills promote <skill>` | Promote a skill for your team |

## `helm init` Options

```bash
helm init                        # Interactive setup
helm init --yes                  # Non-interactive, auto-confirm
helm init --upgrade              # Upgrade local-only to cloud mode
helm init --team <invite-token>  # Join an existing team
```

## Supported IDEs

- **Claude Code**
- **Cursor**

## Helm Cloud

[Helm Cloud](https://tryhelm.ai) adds team rule sync, project linking, and a web dashboard on top of the local CLI. It's optional — Helm works fully offline with a local `.helm/rules.md` file.

## License

MIT
