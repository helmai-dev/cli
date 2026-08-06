/**
 * `helm hooks install|uninstall|status` — manage Helm's zero-touch context
 * hooks in Claude Code's user-scope settings. Install once; every project on
 * this machine (including future ones) gets team context injected with no
 * per-project setup.
 */

import chalk from "chalk";
import {
  getClaudeSettingsPath,
  helmHooksInstalled,
  mergeHelmHooks,
  readClaudeSettings,
  removeHelmHooks,
  writeClaudeSettings,
} from "../lib/claude-settings.js";

export async function hooksInstallCommand(): Promise<void> {
  const settingsPath = getClaudeSettingsPath();
  const settings = readClaudeSettings(settingsPath);
  if (helmHooksInstalled(settings)) {
    console.log(chalk.green(`\n✓ Helm hooks already installed in ${settingsPath}\n`));
    return;
  }
  writeClaudeSettings(mergeHelmHooks(settings), settingsPath);
  console.log(chalk.green(`\n✓ Installed Helm context hooks in ${settingsPath}`));
  console.log(
    chalk.gray(
      "  Every Claude Code session on this machine now starts with your team's shared context.\n" +
        "  Hooks fail open — if the Helm daemon is unreachable, sessions run exactly as before.\n",
    ),
  );
}

export async function hooksUninstallCommand(): Promise<void> {
  const settingsPath = getClaudeSettingsPath();
  const settings = readClaudeSettings(settingsPath);
  if (!helmHooksInstalled(settings)) {
    console.log(chalk.gray(`\nNo Helm hooks found in ${settingsPath}\n`));
    return;
  }
  writeClaudeSettings(removeHelmHooks(settings), settingsPath);
  console.log(chalk.green(`\n✓ Removed Helm hooks from ${settingsPath}\n`));
}

export async function hooksStatusCommand(): Promise<void> {
  const settingsPath = getClaudeSettingsPath();
  let installed = false;
  try {
    installed = helmHooksInstalled(readClaudeSettings(settingsPath));
  } catch {
    console.log(chalk.yellow(`\n${settingsPath} is not valid JSON — cannot determine status.\n`));
    return;
  }
  console.log(
    installed
      ? chalk.green(`\n✓ Helm hooks installed (${settingsPath})\n`)
      : chalk.gray(`\nHelm hooks not installed. Run \`helm hooks install\`.\n`),
  );
}
