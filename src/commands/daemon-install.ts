/**
 * `helm daemon install` / `helm daemon uninstall` — reboot persistence.
 *
 * The daemon's promise is an always-on run target; without an OS-level unit
 * a reboot or logout silently kills it. Per platform:
 *
 * - macOS: launchd LaunchAgent (~/Library/LaunchAgents/ai.tryhelm.daemon.<env>.plist)
 *   supervising `helm daemon start --foreground` with RunAtLoad + KeepAlive.
 * - Linux: systemd user unit (~/.config/systemd/user/helm-daemon-<env>.service),
 *   enabled with `systemctl --user enable --now`.
 * - Windows: a Scheduled Task (`schtasks /sc onlogon`) that runs
 *   `helm daemon start` (the detaching variant) at logon. No supervision —
 *   and note a real Windows test is still pending.
 *
 * The unit is written for the environment active at install time; the daemon
 * process itself always reads ~/.helm/active-env at startup.
 */

import chalk from "chalk";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getActiveEnvironment, getDaemonLogPath } from "../lib/config.js";
import { resolveDaemonSpawn } from "../lib/daemon-spawn.js";
import { stopDaemonIfRunning } from "./daemon.js";

export interface PersistenceState {
  supported: boolean;
  installed: boolean;
  kind: "launchd" | "systemd" | "schtasks" | null;
  /** Plist/unit path, or the task name on Windows. */
  path: string | null;
}

function launchdLabel(env: string): string {
  return `ai.tryhelm.daemon.${env}`;
}

function launchdPlistPath(env: string): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${launchdLabel(env)}.plist`);
}

function systemdUnitName(env: string): string {
  return `helm-daemon-${env}.service`;
}

function systemdUnitPath(env: string): string {
  return path.join(os.homedir(), ".config", "systemd", "user", systemdUnitName(env));
}

function schtasksName(env: string): string {
  return `HelmDaemon-${env}`;
}

export function getPersistenceState(): PersistenceState {
  const env = getActiveEnvironment();

  if (process.platform === "darwin") {
    const plist = launchdPlistPath(env);
    return { supported: true, installed: fs.existsSync(plist), kind: "launchd", path: plist };
  }

  if (process.platform === "linux") {
    const unit = systemdUnitPath(env);
    return { supported: true, installed: fs.existsSync(unit), kind: "systemd", path: unit };
  }

  if (process.platform === "win32") {
    const name = schtasksName(env);
    try {
      execFileSync("schtasks", ["/query", "/tn", name], { stdio: "ignore", windowsHide: true });
      return { supported: true, installed: true, kind: "schtasks", path: name };
    } catch {
      return { supported: true, installed: false, kind: "schtasks", path: name };
    }
  }

  return { supported: false, installed: false, kind: null, path: null };
}

/** How to invoke helm itself (compiled binary vs runtime + entry script). */
function helmInvocation(): string[] | null {
  const plan = resolveDaemonSpawn(process.execPath, process.argv[1]);
  if (!plan) {
    return null;
  }
  return [plan.command, ...plan.args];
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- macOS (launchd) ---

function buildLaunchdPlist(env: string, invocation: string[]): string {
  const args = [...invocation, "daemon", "start", "--foreground"];
  const logPath = getDaemonLogPath();
  const argStrings = args.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(launchdLabel(env))}</string>
  <key>ProgramArguments</key>
  <array>
${argStrings}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

function launchctl(args: string[], ignoreFailure: boolean): void {
  try {
    execFileSync("launchctl", args, { stdio: "ignore" });
  } catch (err) {
    if (!ignoreFailure) {
      throw err;
    }
  }
}

async function installLaunchd(env: string): Promise<void> {
  const invocation = helmInvocation();
  if (!invocation) {
    console.log(chalk.red("\n  Cannot determine how to invoke helm from this runtime.\n"));
    process.exit(1);
  }

  const plistPath = launchdPlistPath(env);
  const label = launchdLabel(env);
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  const domainTarget = `gui/${uid}`;

  // Stop any manually-started daemon so the supervised one can own the loop.
  const wasRunning = await stopDaemonIfRunning();
  if (wasRunning) {
    console.log(chalk.gray("\n  Stopped the manually-started daemon."));
  }

  // Idempotent: boot out any previous unit before (re)writing and loading.
  launchctl(["bootout", `${domainTarget}/${label}`], true);

  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, buildLaunchdPlist(env, invocation));

  try {
    launchctl(["bootstrap", domainTarget, plistPath], false);
  } catch {
    console.log(chalk.red("\n  Wrote the LaunchAgent but `launchctl bootstrap` failed."));
    console.log(chalk.gray(`  Try manually: launchctl bootstrap ${domainTarget} ${plistPath}\n`));
    process.exit(1);
  }

  console.log(chalk.green(`\n  ✓ Installed launchd agent ${label}`));
  console.log(chalk.gray(`    Wrote:  ${plistPath}`));
  console.log(chalk.gray(`    Log:    ${getDaemonLogPath()}`));
  console.log(chalk.gray("    The daemon now starts at login and restarts if it dies."));
  console.log(chalk.gray("    Remove with: helm daemon uninstall\n"));
}

async function uninstallLaunchd(env: string): Promise<void> {
  const plistPath = launchdPlistPath(env);
  const label = launchdLabel(env);
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;

  if (!fs.existsSync(plistPath)) {
    console.log(chalk.yellow("\n  No launchd agent installed for this environment.\n"));
    return;
  }

  launchctl(["bootout", `gui/${uid}/${label}`], true);
  fs.unlinkSync(plistPath);

  console.log(chalk.green(`\n  ✓ Removed launchd agent ${label}`));
  console.log(chalk.gray(`    Deleted: ${plistPath}\n`));
}

// --- Linux (systemd user unit) ---

function buildSystemdUnit(env: string, invocation: string[]): string {
  const exec = [...invocation, "daemon", "start", "--foreground"]
    .map((a) => (a.includes(" ") ? `"${a}"` : a))
    .join(" ");

  return `[Unit]
Description=Helm daemon (${env}) — runs Helm agent work on this machine
After=network-online.target

[Service]
ExecStart=${exec}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function hasSystemd(): boolean {
  try {
    execFileSync("systemctl", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function installSystemd(env: string): Promise<void> {
  if (!hasSystemd()) {
    console.log(chalk.red("\n  systemd is not available on this machine."));
    console.log(chalk.gray("  Run the daemon with `helm daemon start`, or wire `helm daemon start --foreground` into your init system.\n"));
    process.exit(1);
  }

  const invocation = helmInvocation();
  if (!invocation) {
    console.log(chalk.red("\n  Cannot determine how to invoke helm from this runtime.\n"));
    process.exit(1);
  }

  const unitPath = systemdUnitPath(env);
  const unitName = systemdUnitName(env);

  const wasRunning = await stopDaemonIfRunning();
  if (wasRunning) {
    console.log(chalk.gray("\n  Stopped the manually-started daemon."));
  }

  fs.mkdirSync(path.dirname(unitPath), { recursive: true });
  fs.writeFileSync(unitPath, buildSystemdUnit(env, invocation));

  try {
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    execFileSync("systemctl", ["--user", "enable", "--now", unitName], { stdio: "ignore" });
  } catch {
    console.log(chalk.red("\n  Wrote the unit file but enabling it failed."));
    console.log(chalk.gray(`  Try manually: systemctl --user enable --now ${unitName}\n`));
    process.exit(1);
  }

  console.log(chalk.green(`\n  ✓ Installed systemd user unit ${unitName}`));
  console.log(chalk.gray(`    Wrote:  ${unitPath}`));
  console.log(chalk.gray(`    Log:    ${getDaemonLogPath()}`));
  console.log(chalk.gray("    Tip: run `loginctl enable-linger` so it also runs while you're logged out."));
  console.log(chalk.gray("    Remove with: helm daemon uninstall\n"));
}

async function uninstallSystemd(env: string): Promise<void> {
  const unitPath = systemdUnitPath(env);
  const unitName = systemdUnitName(env);

  if (!fs.existsSync(unitPath)) {
    console.log(chalk.yellow("\n  No systemd unit installed for this environment.\n"));
    return;
  }

  try {
    execFileSync("systemctl", ["--user", "disable", "--now", unitName], { stdio: "ignore" });
  } catch {
    // Unit may already be stopped/disabled — removing the file is what matters.
  }
  fs.unlinkSync(unitPath);
  try {
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  } catch {
    // Best effort
  }

  console.log(chalk.green(`\n  ✓ Removed systemd user unit ${unitName}`));
  console.log(chalk.gray(`    Deleted: ${unitPath}\n`));
}

// --- Windows (Scheduled Task) ---

async function installSchtasks(env: string): Promise<void> {
  const invocation = helmInvocation();
  if (!invocation) {
    console.log(chalk.red("\n  Cannot determine how to invoke helm from this runtime.\n"));
    process.exit(1);
  }

  const name = schtasksName(env);
  // `daemon start` (not --foreground): the CLI detaches a hidden daemon child
  // and exits, so no console window lingers after logon. schtasks provides no
  // supervision — if the daemon dies it stays dead until the next logon.
  const command = [...invocation, "daemon", "start"]
    .map((a) => (a.includes(" ") ? `"${a}"` : a))
    .join(" ");

  try {
    execFileSync(
      "schtasks",
      ["/create", "/f", "/sc", "onlogon", "/tn", name, "/tr", command],
      { stdio: "ignore", windowsHide: true },
    );
  } catch {
    console.log(chalk.red("\n  Failed to create the scheduled task."));
    console.log(chalk.gray(`  Try manually: schtasks /create /f /sc onlogon /tn ${name} /tr '${command}'\n`));
    process.exit(1);
  }

  console.log(chalk.green(`\n  ✓ Installed scheduled task ${name}`));
  console.log(chalk.gray(`    Runs at logon: ${command}`));
  console.log(chalk.gray(`    Log: ${getDaemonLogPath()}`));
  console.log(chalk.gray("    Remove with: helm daemon uninstall\n"));
}

async function uninstallSchtasks(env: string): Promise<void> {
  const name = schtasksName(env);

  try {
    execFileSync("schtasks", ["/delete", "/f", "/tn", name], { stdio: "ignore", windowsHide: true });
    console.log(chalk.green(`\n  ✓ Removed scheduled task ${name}\n`));
  } catch {
    console.log(chalk.yellow("\n  No scheduled task installed for this environment.\n"));
  }
}

// --- Commands ---

export async function daemonInstallCommand(): Promise<void> {
  const env = getActiveEnvironment();

  switch (process.platform) {
    case "darwin":
      await installLaunchd(env);
      return;
    case "linux":
      await installSystemd(env);
      return;
    case "win32":
      await installSchtasks(env);
      return;
    default:
      console.log(chalk.red(`\n  Persistence is not supported on ${process.platform}.\n`));
      process.exit(1);
  }
}

export async function daemonUninstallCommand(): Promise<void> {
  const env = getActiveEnvironment();

  switch (process.platform) {
    case "darwin":
      await uninstallLaunchd(env);
      return;
    case "linux":
      await uninstallSystemd(env);
      return;
    case "win32":
      await uninstallSchtasks(env);
      return;
    default:
      console.log(chalk.red(`\n  Persistence is not supported on ${process.platform}.\n`));
      process.exit(1);
  }
}
