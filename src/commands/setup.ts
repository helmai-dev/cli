/**
 * `helm setup` — the one-command onboarding wizard. Walks a fresh machine
 * through the whole wedge: connect (device-code auth) → enable Claude Code
 * context hooks → first usage scan → dashboard URL. Every step is skippable
 * and re-runnable; running setup on an already-configured machine is a
 * fast no-op checklist.
 *
 * install.sh chains into this after a fresh install (stdin re-attached to
 * /dev/tty so prompts work under `curl | bash`).
 */

import * as readline from "node:readline/promises";
import chalk from "chalk";
import { fetchAuthenticatedUser } from "../lib/api-web.js";
import { getApiUrl, loadCredentials } from "../lib/config.js";
import { helmHooksInstalled, readClaudeSettings } from "../lib/claude-settings.js";

/** Pure: interpret a y/n answer with a default. Exported for tests. */
export function parseYesNo(input: string, defaultYes: boolean): boolean {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "") {
    return defaultYes;
  }
  return trimmed === "y" || trimmed === "yes";
}

async function ask(rl: readline.Interface, question: string, defaultYes = true): Promise<boolean> {
  const suffix = defaultYes ? chalk.gray(" (Y/n) ") : chalk.gray(" (y/N) ");
  const answer = await rl.question(`  ${question}${suffix}`);
  return parseYesNo(answer, defaultYes);
}

async function isConnected(): Promise<boolean> {
  if (!loadCredentials()?.api_key) {
    return false;
  }
  try {
    await fetchAuthenticatedUser();
    return true;
  } catch {
    return false;
  }
}

export async function setupCommand(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.log(chalk.yellow("\nhelm setup is interactive — run it in a terminal.\n"));
    console.log("Or run the steps individually:");
    console.log("  helm connect        link this machine to your team");
    console.log("  helm hooks install  enable team context in Claude Code");
    console.log("  helm scan           report + sync your AI usage\n");
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(chalk.cyan.bold("\n  ⎈ Helm Setup\n"));
    console.log(
      chalk.gray(
        "  Three steps: connect this machine, enable team context for Claude Code,\n" +
          "  and scan your recent AI usage. Each step asks first; nothing is silent.\n",
      ),
    );

    // Step 1 — connect
    if (await isConnected()) {
      console.log(chalk.green("  ✓ Already connected to helm-web\n"));
    } else if (await ask(rl, "Connect this machine to your Helm team (opens your browser)?")) {
      const { connectCommand } = await import("./connect.js");
      await connectCommand({});
      if (!(await isConnected())) {
        console.log(
          chalk.yellow("\n  Setup paused — connection didn't complete. Re-run `helm setup` anytime.\n"),
        );
        return;
      }
    } else {
      console.log(chalk.gray("\n  Skipped. Re-run `helm setup` when you're ready to connect.\n"));
      return;
    }

    // Step 2 — hooks
    let hooksOn = false;
    try {
      hooksOn = helmHooksInstalled(readClaudeSettings());
    } catch {
      // Unreadable settings — hooksInstallCommand will explain if chosen.
    }
    if (hooksOn) {
      console.log(chalk.green("  ✓ Claude Code context hooks already installed\n"));
    } else if (
      await ask(
        rl,
        "Enable shared team context for every Claude Code session? (fail-open; removable with `helm hooks uninstall`)",
      )
    ) {
      const { hooksInstallCommand } = await import("./hooks.js");
      await hooksInstallCommand();
    } else {
      console.log(chalk.gray("  Skipped — enable later with `helm hooks install`.\n"));
    }

    // Step 3 — scan
    if (
      await ask(rl, "Scan your last 30 days of local AI usage and sync your team dashboard?")
    ) {
      const { scanCommand } = await import("./scan.js");
      await scanCommand({});
    } else {
      console.log(chalk.gray("  Skipped — run `helm scan` anytime.\n"));
    }

    console.log(chalk.cyan.bold("  Setup complete."));
    console.log(`  Your team dashboard: ${chalk.underline(`${getApiUrl()}/beta`)}\n`);
  } finally {
    rl.close();
  }
}
