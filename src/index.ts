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
  .option("--url <url>", "helm-web base URL (e.g. https://your-helm-web.test)")
  .option("--env <name>", "Environment name to store this connection under", "web")
  .action(async (options: { url?: string; env?: string }) => {
    await connectCommand(options);
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
  .action(async () => {
    await daemonStartCommand();
  });

daemon
  .command("stop")
  .description("Stop the daemon")
  .action(async () => {
    await daemonStopCommand();
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
    const daemonWasRunning = stopDaemonIfRunning();
    if (daemonWasRunning) {
      console.log(chalk.gray("  Stopped daemon for update..."));
    }

    console.log(chalk.gray("  Updating...\n"));

    try {
      execSync(updateCommand, {
        encoding: "utf-8",
        stdio: "inherit",
        shell: "/bin/sh",
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
