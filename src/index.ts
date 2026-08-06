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
import {
  daemonInstallCommand,
  daemonUninstallCommand,
} from "./commands/daemon-install.js";
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
  .description("Connect this machine to a helm-web backend as an agent runner")
  .option("--url <url>", "helm-web base URL (defaults to https://tryhelm.ai)")
  .option("--env <name>", "Environment name to store this connection under (defaults to the active environment)")
  .action(async (options: { url?: string; env?: string }) => {
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
  .description("Report AI usage from local agent transcripts and sync it to your team")
  .option("--days <n>", "How many days back to scan (default 30)")
  .option("--no-upload", "Print the report without syncing to helm-web")
  .option("--json", "Emit the full summary as JSON")
  .action(async (options: { days?: string; upload?: boolean; json?: boolean }) => {
    const { scanCommand } = await import("./commands/scan.js");
    await scanCommand(options);
  });

const hooks = program
  .command("hooks")
  .description("Manage Helm's zero-touch context hooks for Claude Code");

hooks
  .command("install")
  .description("Install Helm context injection for every Claude Code session on this machine")
  .action(async () => {
    const { hooksInstallCommand } = await import("./commands/hooks.js");
    await hooksInstallCommand();
  });

hooks
  .command("uninstall")
  .description("Remove Helm's Claude Code hooks")
  .action(async () => {
    const { hooksUninstallCommand } = await import("./commands/hooks.js");
    await hooksUninstallCommand();
  });

hooks
  .command("status")
  .description("Show whether Helm's Claude Code hooks are installed")
  .action(async () => {
    const { hooksStatusCommand } = await import("./commands/hooks.js");
    await hooksStatusCommand();
  });

program
  .command("auth-import", { hidden: true })
  .description("Provision credentials from a trusted local caller (reads JSON on stdin)")
  .action(async () => {
    const { authImportCommand } = await import("./commands/auth-import.js");
    await authImportCommand();
  });

program
  .command("inject", { hidden: true })
  .description("Hook handler: print team context for the current session (reads stdin)")
  .action(async () => {
    const { injectCommand } = await import("./commands/inject.js");
    await injectCommand();
  });

program
  .command("map")
  .description("Register a local checkout for a helm-web project on this machine")
  .argument("<projectId>", "helm-web project id")
  .argument("[path]", "Local checkout path (defaults to the current directory)")
  .action(async (projectId: string, localPath?: string) => {
    await mapProjectCommand(projectId, localPath);
  });

const daemon = program
  .command("daemon")
  .description("Manage the background agent-runner daemon");

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

// When spawned as the background daemon, run the loop directly and skip
// Commander.js (avoids Bun compiled-binary arg issues).
if (process.env.HELM_DAEMON_MODE === "1") {
  import("./lib/daemon-loop-web.js").then((m) => m.runWebDaemonLoop());
} else {
  checkForUpdate();
  program.parse();
}
