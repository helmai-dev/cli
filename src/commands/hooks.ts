/** `helm hooks install|uninstall|status` — manage all supported agent hooks. */

import chalk from "chalk";
import {
  getClaudeSettingsPath,
  helmHooksInstalled as claudeHooksInstalled,
  mergeHelmHooks,
  readClaudeSettings,
  removeHelmHooks,
  writeClaudeSettings,
} from "../lib/claude-settings.js";
import {
  codexHooksInstalled,
  getCodexHooksPath,
  mergeCodexHooks,
  readCodexHooks,
  removeCodexHooks,
  writeCodexHooks,
} from "../lib/codex-hooks.js";
import {
  cursorHooksInstalled,
  getCursorHooksPath,
  mergeCursorHooks,
  readCursorHooks,
  removeCursorHooks,
  writeCursorHooks,
} from "../lib/cursor-hooks.js";
import {
  assertOpenCodePluginWritable,
  getOpenCodePluginPath,
  openCodeHooksInstalled,
  removeOpenCodePlugin,
  writeOpenCodePlugin,
} from "../lib/opencode-hooks.js";

export interface AgentHookStatus {
  name: string;
  path: string;
  installed: boolean;
}

export function getAgentHookStatus(): AgentHookStatus[] {
  const claudePath = getClaudeSettingsPath();
  const codexPath = getCodexHooksPath();
  const cursorPath = getCursorHooksPath();
  const openCodePath = getOpenCodePluginPath();
  return [
    {
      name: "Claude Code",
      path: claudePath,
      installed: claudeHooksInstalled(readClaudeSettings(claudePath)),
    },
    {
      name: "Codex",
      path: codexPath,
      installed: codexHooksInstalled(readCodexHooks(codexPath)),
    },
    {
      name: "Cursor",
      path: cursorPath,
      installed: cursorHooksInstalled(readCursorHooks(cursorPath)),
    },
    { name: "OpenCode", path: openCodePath, installed: openCodeHooksInstalled(openCodePath) },
  ];
}

export function allAgentHooksInstalled(): boolean {
  try {
    return getAgentHookStatus().every((provider) => provider.installed);
  } catch {
    return false;
  }
}

export async function hooksInstallCommand(): Promise<void> {
  const claudePath = getClaudeSettingsPath();
  const codexPath = getCodexHooksPath();
  const cursorPath = getCursorHooksPath();
  const openCodePath = getOpenCodePluginPath();

  // Validate every destination before writing any of them, so malformed JSON
  // or an unrelated OpenCode plugin cannot leave a partial installation.
  const claude = readClaudeSettings(claudePath);
  const codex = readCodexHooks(codexPath);
  const cursor = readCursorHooks(cursorPath);
  assertOpenCodePluginWritable(openCodePath);

  writeClaudeSettings(mergeHelmHooks(claude), claudePath);
  writeCodexHooks(mergeCodexHooks(codex), codexPath);
  writeCursorHooks(mergeCursorHooks(cursor), cursorPath);
  writeOpenCodePlugin(openCodePath);

  console.log(chalk.green("\n✓ Installed Helm agent integrations"));
  for (const { name, path } of getAgentHookStatus()) {
    console.log(chalk.gray(`  ${name.padEnd(12)} ${path}`));
  }
  console.log(
    chalk.gray(
      "\n  Shared team context is now available in Claude Code, Codex, Cursor, and OpenCode.\n" +
        "  Hooks fail open — Helm being unavailable never blocks an agent session.\n",
    ),
  );
  console.log(
    chalk.yellow(
      "  Codex will ask you to review and trust newly installed user hooks the first time.\n",
    ),
  );
}

export async function hooksUninstallCommand(): Promise<void> {
  const claudePath = getClaudeSettingsPath();
  const codexPath = getCodexHooksPath();
  const cursorPath = getCursorHooksPath();
  const openCodePath = getOpenCodePluginPath();

  const claude = readClaudeSettings(claudePath);
  const codex = readCodexHooks(codexPath);
  const cursor = readCursorHooks(cursorPath);

  writeClaudeSettings(removeHelmHooks(claude), claudePath);
  writeCodexHooks(removeCodexHooks(codex), codexPath);
  writeCursorHooks(removeCursorHooks(cursor), cursorPath);
  removeOpenCodePlugin(openCodePath);
  console.log(chalk.green("\n✓ Removed Helm agent integrations\n"));
}

export async function hooksStatusCommand(): Promise<void> {
  let statuses: AgentHookStatus[];
  try {
    statuses = getAgentHookStatus();
  } catch (error) {
    console.log(chalk.yellow(`\n${error instanceof Error ? error.message : String(error)}\n`));
    return;
  }
  console.log("");
  for (const provider of statuses) {
    const icon = provider.installed ? chalk.green("✓") : chalk.gray("○");
    console.log(`  ${icon} ${provider.name.padEnd(12)} ${chalk.gray(provider.path)}`);
  }
  if (!statuses.every((provider) => provider.installed)) {
    console.log(chalk.gray("\n  Run `helm hooks install` to install missing integrations.\n"));
  } else {
    console.log("");
  }
}
