/**
 * `helm setup` — the one-command onboarding wizard. Walks a fresh machine
 * through the whole wedge: connect (device-code auth) → enable coding-agent
 * context hooks → first usage scan → dashboard URL. Every step is skippable
 * and re-runnable; running setup on an already-configured machine is a
 * fast no-op checklist.
 *
 * install.sh chains into this after a fresh install (stdin re-attached to
 * /dev/tty so prompts work under `curl | bash`).
 */

import * as fs from "node:fs";
import * as readline from "node:readline/promises";
import * as tty from "node:tty";
import chalk from "chalk";
import { accountUrls, hasLinkedAccount } from "../lib/account-link.js";
import { fetchAuthenticatedUser } from "../lib/api-web.js";
import { getApiUrl, loadCredentials } from "../lib/config.js";
import { allAgentHooksInstalled } from "./hooks.js";

/** Pure: interpret a y/n answer with a default. Exported for tests. */
export function parseYesNo(input: string, defaultYes: boolean): boolean {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "") {
    return defaultYes;
  }
  return trimmed === "y" || trimmed === "yes";
}

/**
 * Ask one question on a readline interface that is opened and closed around
 * that question ONLY.
 *
 * Never hold an interface open while a step runs: readline intercepts Ctrl+C
 * (it emits its own 'SIGINT' event instead of the default exit), so a stray
 * open interface makes the whole terminal unkillable during connect's approval
 * wait — it reads as a hard freeze with no way out.
 */
async function ask(
  input: NodeJS.ReadableStream,
  question: string,
  defaultYes = true,
): Promise<boolean> {
  const rl = readline.createInterface({ input, output: process.stdout });
  rl.on("SIGINT", () => {
    rl.close();
    console.log(chalk.gray("\n\n  Setup cancelled. Run `helm setup` anytime.\n"));
    process.exit(130);
  });
  try {
    const suffix = defaultYes ? chalk.gray(" (Y/n) ") : chalk.gray(" (y/N) ");
    const answer = await rl.question(`  ${question}${suffix}`);
    return parseYesNo(answer, defaultYes);
  } finally {
    rl.close();
  }
}

/**
 * Return a real terminal stream for prompts, even when the installer itself is
 * being read from stdin (`curl | bash`). Opening the controlling terminal here
 * is more reliable in Bun-compiled binaries than inheriting a shell redirect.
 */
function openPromptInput(): { input: NodeJS.ReadableStream; close: () => void } | null {
  if (process.platform !== "win32") {
    try {
      const input = new tty.ReadStream(fs.openSync("/dev/tty", "r"));
      return { input, close: () => input.destroy() };
    } catch {
      // Fall through to stdin for terminals without /dev/tty.
    }
  }

  if (process.stdin.isTTY) {
    return { input: process.stdin, close: () => {} };
  }

  return null;
}

async function isConnected(): Promise<boolean> {
  if (!hasLinkedAccount(loadCredentials())) {
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
  const promptInput = openPromptInput();
  if (!promptInput) {
    const { registerUrl } = accountUrls(getApiUrl());
    console.log(chalk.yellow("\nhelm setup is interactive — run it in a terminal.\n"));
    console.log("Create a Helm Web account first, then link this CLI:");
    console.log(`  ${registerUrl}`);
    console.log("  helm connect        link this machine to that account");
    console.log("  helm hooks install  enable team context in supported coding agents");
    console.log("  helm scan           report + sync your AI usage\n");
    return;
  }

  try {
    console.log(chalk.cyan.bold("\n  ⎈ Helm Setup\n"));
    console.log(
      chalk.gray(
        "  Three steps: connect this machine, enable team context for your coding agents,\n" +
          "  and scan your recent AI usage. Each step asks first; nothing is silent.\n",
      ),
    );

    // Step 1 — connect
    if (await isConnected()) {
      console.log(chalk.green("  ✓ Already connected to helm-web\n"));
    } else if (
      await ask(promptInput.input, "Connect this machine to your Helm team (opens your browser)?")
    ) {
      const { connectCommand } = await import("./connect.js");
      await connectCommand({});
      if (!(await isConnected())) {
        console.log(
          chalk.yellow(
            "\n  Setup paused — connection didn't complete. Re-run `helm setup` anytime.\n",
          ),
        );
        return;
      }
    } else {
      const { registerUrl } = accountUrls(getApiUrl());
      console.log(
        chalk.gray(
          `\n  Skipped. Create an account at ${registerUrl}, then run \`helm connect\`.\n`,
        ),
      );
      return;
    }

    // Step 2 — hooks
    const hooksOn = allAgentHooksInstalled();
    if (hooksOn) {
      console.log(
        chalk.green("  ✓ Coding-agent integrations already installed\n"),
      );
    } else if (
      await ask(
        promptInput.input,
        "Enable shared team context in supported coding agents? (fail-open; removable with `helm hooks uninstall`)",
      )
    ) {
      const { hooksInstallCommand } = await import("./hooks.js");
      await hooksInstallCommand();
    } else {
      console.log(chalk.gray("  Skipped — enable later with `helm hooks install`.\n"));
    }

    // Step 3 — scan
    if (
      await ask(
        promptInput.input,
        "Scan your last 30 days of local AI usage and sync your team dashboard?",
      )
    ) {
      const { scanCommand } = await import("./scan.js");
      await scanCommand({});
    } else {
      console.log(chalk.gray("  Skipped — run `helm scan` anytime.\n"));
    }

    console.log(chalk.cyan.bold("  Setup complete."));
    console.log(
      chalk.gray(
        "  Team context is available across supported agents; Claude Code and Codex usage syncs automatically.",
      ),
    );
    console.log(`  Your team dashboard: ${chalk.underline(`${getApiUrl()}/usage`)}\n`);
  } finally {
    promptInput.close();
  }
}
