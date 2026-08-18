#!/usr/bin/env node
/**
 * Helm daemon CLI. One job: connect a machine to helm-web so it can run
 * Helm agent sessions — yours or your teammates' — queued from the desktop
 * app or the web. The desktop app is the product surface; this is the
 * headless runner for always-on machines.
 */

import { Command } from "commander";
import {
  daemonInfoCommand,
  daemonStartCommand,
  daemonStatusCommand,
  daemonStopCommand,
} from "./commands/daemon.js";
import { daemonInstallCommand, daemonUninstallCommand } from "./commands/daemon-install.js";
import { connectCommand } from "./commands/connect.js";
import { mapProjectCommand } from "./commands/map.js";
import { envCreateCommand, envListCommand, envSwitchCommand } from "./commands/env.js";
import { checkForUpdate } from "./lib/update-check.js";
import pkg from "../package.json";

const program = new Command();

program
  .name("helm")
  .description("Run Helm agents on this machine, controlled from helm-web")
  .version(pkg.version);

program
  .command("connect")
  .description("Link this CLI to a Helm Web account (device-code auth)")
  .option("--url <url>", "helm-web base URL (defaults to https://tryhelm.ai)")
  .option(
    "--env <name>",
    "Environment name to store this connection under (defaults to the active environment)",
  )
  .option("--json", "Emit token-free NDJSON events for a trusted local UI")
  .action(async (options: { url?: string; env?: string; json?: boolean }) => {
    await connectCommand(options);
  });

program
  .command("setup")
  .description("Guided setup: connect, enable team context hooks, and run your first scan")
  .action(async () => {
    const { setupCommand } = await import("./commands/setup.js");
    await setupCommand();
  });

program
  .command("scan")
  .description("Report local AI usage and sync it to your Helm Web team dashboard")
  .option("--days <n>", "How many days back to scan (default 30)")
  .option("--no-upload", "Print the report without syncing to helm-web")
  .option("--json", "Emit the full summary as JSON")
  .option("--quiet", "Suppress output and fail open (used by automatic session-end sync)")
  .action(async (options: { days?: string; upload?: boolean; json?: boolean; quiet?: boolean }) => {
    const { scanCommand } = await import("./commands/scan.js");
    await scanCommand(options);
  });

program
  .command("audit")
  .description(
    "Print observed AI spend from local transcripts, or from a Helm Web team rollup with --team. Local path does not require an account. Does not compute identified savings.",
  )
  .option("--days <n>", "How many days back to scan or roll up (default 30)")
  .option("--no-upload", "Skip syncing even if this CLI is already linked. No-op with --team")
  .option("--json", "Emit the audit snapshot as JSON")
  .option("--users <n>", "Self-reported people on the team who use AI coding tools")
  .option("--teams <n>", "Self-reported team count. Does not multiply the replay scenario")
  .option(
    "--team <id>",
    "Helm Web team id. Prints that team's uploaded usage rollup. shared_projects and shared_paths print as observed overlap when present. Requires helm connect",
  )
  .action(
    async (options: {
      days?: string;
      upload?: boolean;
      json?: boolean;
      users?: string;
      teams?: string;
      team?: string;
    }) => {
      const { auditCommand } = await import("./commands/audit.js");
      await auditCommand(options);
    },
  );

const hooks = program
  .command("hooks")
  .description("Manage Helm's zero-touch coding-agent integrations");

hooks
  .command("install")
  .description("Install Helm context injection for supported coding agents on this machine")
  .action(async () => {
    const { hooksInstallCommand } = await import("./commands/hooks.js");
    await hooksInstallCommand();
  });

hooks
  .command("uninstall")
  .description("Remove Helm's coding-agent integrations")
  .action(async () => {
    const { hooksUninstallCommand } = await import("./commands/hooks.js");
    await hooksUninstallCommand();
  });

hooks
  .command("status")
  .description("Show Helm integration status for each coding agent")
  .option("--json", "Emit machine-readable integration status")
  .action(async (options: { json?: boolean }) => {
    const { hooksStatusCommand } = await import("./commands/hooks.js");
    await hooksStatusCommand(options);
  });

program
  .command("auth-import", { hidden: true })
  .description("Provision credentials from a trusted local caller (reads JSON on stdin)")
  .action(async () => {
    const { authImportCommand } = await import("./commands/auth-import.js");
    await authImportCommand();
  });

program
  .command("whoami")
  .description("Show which Helm Web account and machine this CLI is linked as")
  .option("--json", "Emit machine-readable JSON (no token is ever printed)")
  .action(async (options: { json?: boolean }) => {
    const { whoamiCommand } = await import("./commands/whoami.js");
    await whoamiCommand(options);
  });

program
  .command("relay", { hidden: true })
  .description("Publish a local harness's agent activity (reads NDJSON on stdin)")
  .action(async () => {
    const { relayCommand } = await import("./commands/relay.js");
    await relayCommand();
  });

program
  .command("code-bridge", { hidden: true })
  .description("Serve token-blind read/auth requests for a trusted local Helm Code process")
  .option("--inbound", "Allow the fixed Helm Code inbound work surface")
  .action(async (options: { inbound?: boolean }) => {
    const { codeBridgeCommand } = await import("./commands/code-bridge.js");
    await codeBridgeCommand(options);
  });

program
  .command("inject", { hidden: true })
  .description("Hook handler: print team context for the current session (reads stdin)")
  .option("--format <format>", "Hook output protocol (plain, codex, cursor, gemini, or copilot)")
  .action(async (options: { format?: string }) => {
    const { injectCommand } = await import("./commands/inject.js");
    await injectCommand(options);
  });

program
  .command("observe", { hidden: true })
  .description("Hook handler: retain bounded local tool evidence for the active turn")
  .option("--format <format>", "Hook output protocol (plain, codex, or gemini)")
  .action(async (options: { format?: string }) => {
    const { observeCommand } = await import("./commands/observe.js");
    await observeCommand(options);
  });

program
  .command("learn", { hidden: true })
  .description("Hook handler: submit a reviewable learning candidate after a turn")
  .option("--format <format>", "Hook output protocol (plain or gemini)")
  .action(async (options: { format?: string }) => {
    const { learnCommand } = await import("./commands/learn.js");
    await learnCommand(options);
  });

program
  .command("map")
  .description("Register a local checkout for a helm-web project on this machine")
  .argument("<projectId>", "helm-web project id")
  .argument("[path]", "Local checkout path (defaults to the current directory)")
  .action(async (projectId: string, localPath?: string) => {
    await mapProjectCommand(projectId, localPath);
  });

const proxy = program
  .command("proxy")
  .description(
    "Loopback model proxy: pass Anthropic Messages and OpenAI-compatible chat through to the real providers, and record bounded usage on this machine",
  )
  .option("--host <host>", "loopback bind address", "127.0.0.1")
  .option("--port <n>", "preferred port (uses a free port if this one is taken)", "8787")
  .option("--daemon", "run in the background")
  .action(async (options: { host?: string; port?: string; daemon?: boolean }) => {
    const { proxyCommand } = await import("./commands/proxy.js");
    await proxyCommand(options);
  });

proxy
  .command("stop")
  .description("Stop a background helm proxy")
  .action(async () => {
    const { proxyStopCommand } = await import("./commands/proxy.js");
    await proxyStopCommand();
  });

program
  .command("wrap")
  .description("Point Claude Code or Codex at the local Helm proxy")
  .argument("<agent>", "claude or codex")
  .option("--undo", "restore the previous provider URL")
  .action(async (agent: string, options: { undo?: boolean }) => {
    const { wrapCommand } = await import("./commands/wrap.js");
    await wrapCommand(agent, options);
  });

program
  .command("unwrap")
  .description("Restore Claude Code or Codex to the provider URL they used before helm wrap")
  .argument("<agent>", "claude or codex")
  .action(async (agent: string) => {
    const { unwrapCommand } = await import("./commands/wrap.js");
    await unwrapCommand(agent);
  });

const daemon = program.command("daemon").description("Manage the background agent-runner daemon");

daemon
  .command("start")
  .description("Start the daemon (claims and runs queued agent work)")
  .option(
    "--foreground",
    "Run the daemon loop in this process (used by launchd/systemd supervision)",
  )
  .action(async (options: { foreground?: boolean }) => {
    await daemonStartCommand(options);
  });

daemon
  .command("stop")
  .description("Stop the daemon")
  .action(async () => {
    await daemonStopCommand();
  });

daemon
  .command("install")
  .description("Keep the daemon running across reboots (launchd/systemd/scheduled task)")
  .action(async () => {
    await daemonInstallCommand();
  });

daemon
  .command("uninstall")
  .description("Remove the reboot-persistence unit installed by `helm daemon install`")
  .action(async () => {
    await daemonUninstallCommand();
  });

daemon
  .command("status")
  .description("Show daemon status")
  .action(async () => {
    await daemonStatusCommand();
  });

daemon
  .command("info")
  .description("Show daemon configuration and paths")
  .action(async () => {
    await daemonInfoCommand();
  });

const env = program
  .command("env", { hidden: true })
  .description("Manage Helm environments")
  .action(async () => {
    await envListCommand();
  });

env
  .command("switch")
  .description("Switch to a different environment")
  .argument("<name>", "Environment name (e.g. web, local)")
  .action(async (name: string) => {
    await envSwitchCommand(name);
  });

env
  .command("create")
  .description("Create a new environment")
  .argument("<name>", "Environment name (e.g. web, staging)")
  .option("--url <url>", "helm-web URL for this environment")
  .action(async (name: string, options: { url?: string }) => {
    await envCreateCommand(name, options);
  });

program
  .command("logout")
  .description("Clear Helm credentials for the active environment")
  .action(async () => {
    const { clearCredentials } = await import("./lib/config.js");
    const chalk = (await import("chalk")).default;

    clearCredentials();
    console.log(chalk.green("\n✓ Logged out successfully\n"));
  });

program
  .command("update")
  .description("Update the Helm daemon CLI to the latest version")
  .action(async () => {
    const chalk = (await import("chalk")).default;
    const { execSync } = await import("child_process");
    const { getInstallSource, getUpdateCommandForSource } = await import("./lib/config.js");
    const { stopDaemonIfRunning, startDaemon } = await import("./commands/daemon.js");
    const source = getInstallSource();
    const updateCommand = getUpdateCommandForSource(source);

    console.log(chalk.cyan.bold("\n  ⎈ Helm Update\n"));
    console.log(chalk.gray(`  Current version: ${pkg.version}`));
    console.log(chalk.gray(`  Install method:  ${source}`));
    console.log("");

    // Stop the daemon before updating so replacing the binary can't crash a
    // live run mid-claim; restart it afterwards.
    const daemonWasRunning = await stopDaemonIfRunning();
    if (daemonWasRunning) {
      console.log(chalk.gray("  Stopped daemon for update..."));
    }

    console.log(chalk.gray("  Updating...\n"));

    try {
      // No explicit shell: execSync picks the platform default
      // (/bin/sh on unix, cmd.exe on Windows).
      execSync(updateCommand, {
        encoding: "utf-8",
        stdio: "inherit",
        env: { ...process.env, HELM_UPDATE_ONLY: "1" },
      });
      console.log(chalk.green("\n  ✓ Update complete"));
    } catch {
      console.log(chalk.red("\n  ✗ Update failed"));
      console.log(chalk.gray(`  Run manually: ${updateCommand}`));
    }

    if (daemonWasRunning) {
      await startDaemon();
      console.log(chalk.gray("  Restarted daemon."));
    }
    console.log("");
  });

// When spawned as the background daemon or proxy, run that loop directly and
// skip Commander.js (avoids Bun compiled-binary arg issues).
if (process.env.HELM_PROXY_MODE === "1") {
  import("./commands/proxy.js").then((m) => m.runProxyChildFromEnv());
} else if (process.env.HELM_DAEMON_MODE === "1") {
  import("./lib/daemon-loop-web.js").then((m) => m.runWebDaemonLoop());
} else {
  checkForUpdate();
  program.parseAsync().then(
    () => process.exit(process.exitCode ?? 0),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}
