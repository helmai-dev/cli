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
import {
  assertCopilotHooksWritable,
  copilotHooksInstalled,
  getCopilotHooksPath,
  removeCopilotHooks,
  writeCopilotHooks,
} from "../lib/copilot-hooks.js";
import {
  geminiHooksInstalled,
  getGeminiSettingsPath,
  mergeGeminiHooks,
  readGeminiSettings,
  removeGeminiHooks,
  writeGeminiSettings,
} from "../lib/gemini-hooks.js";
import {
  assertPiExtensionWritable,
  getPiExtensionPath,
  piHooksInstalled,
  removePiExtension,
  writePiExtension,
} from "../lib/pi-hooks.js";
import {
  ampHooksInstalled,
  assertAmpPluginWritable,
  getAmpPluginPath,
  removeAmpPlugin,
  writeAmpPlugin,
} from "../lib/amp-hooks.js";
import {
  assertKiloPluginWritable,
  getKiloPluginPath,
  kiloHooksInstalled,
  removeKiloPlugin,
  writeKiloPlugin,
} from "../lib/kilo-hooks.js";
import {
  anyCommandAvailable,
  getUnsupportedAgentRecommendations,
} from "../lib/agent-runtime-detection.js";
import {
  allHelmMcpHostsInstalled,
  assertMcpHostsWritable,
  installHelmMcpHosts,
  mcpHostStatus,
  uninstallHelmMcpHosts,
} from "../lib/mcp-hosts.js";

export interface AgentHookStatus {
  name: string;
  path: string;
  installed: boolean;
  derivedFrom?: string;
  runtimeDetected: boolean;
}

export function getAgentHookStatus(): AgentHookStatus[] {
  const claudePath = getClaudeSettingsPath();
  const codexPath = getCodexHooksPath();
  const cursorPath = getCursorHooksPath();
  const openCodePath = getOpenCodePluginPath();
  const geminiPath = getGeminiSettingsPath();
  const copilotPath = getCopilotHooksPath();
  const piPath = getPiExtensionPath();
  const ampPath = getAmpPluginPath();
  const kiloPath = getKiloPluginPath();
  const claudeInstalled = claudeHooksInstalled(readClaudeSettings(claudePath));
  return [
    {
      name: "Claude Code",
      path: claudePath,
      installed: claudeInstalled,
      runtimeDetected: anyCommandAvailable(["claude"]),
    },
    {
      name: "Grok Code",
      path: `${claudePath} (Claude compatibility)`,
      installed: claudeInstalled,
      derivedFrom: "Claude Code",
      runtimeDetected: anyCommandAvailable(["grok"]),
    },
    {
      name: "Codex",
      path: codexPath,
      installed: codexHooksInstalled(readCodexHooks(codexPath)),
      runtimeDetected: anyCommandAvailable(["codex"]),
    },
    {
      name: "Cursor",
      path: cursorPath,
      installed: cursorHooksInstalled(readCursorHooks(cursorPath)),
      runtimeDetected: anyCommandAvailable(["cursor-agent"]),
    },
    {
      name: "OpenCode",
      path: openCodePath,
      installed: openCodeHooksInstalled(openCodePath),
      runtimeDetected: anyCommandAvailable(["opencode"]),
    },
    {
      name: "Gemini CLI",
      path: geminiPath,
      installed: geminiHooksInstalled(readGeminiSettings(geminiPath)),
      runtimeDetected: anyCommandAvailable(["gemini"]),
    },
    {
      name: "Copilot CLI",
      path: copilotPath,
      installed: copilotHooksInstalled(copilotPath),
      runtimeDetected: anyCommandAvailable(["copilot"]),
    },
    {
      name: "Pi",
      path: piPath,
      installed: piHooksInstalled(piPath),
      runtimeDetected: anyCommandAvailable(["pi"]),
    },
    {
      name: "Amp",
      path: ampPath,
      installed: ampHooksInstalled(ampPath),
      runtimeDetected: anyCommandAvailable(["amp"]),
    },
    {
      name: "Kilo",
      path: kiloPath,
      installed: kiloHooksInstalled(kiloPath),
      runtimeDetected: anyCommandAvailable(["kilo"]),
    },
  ];
}

export function allAgentHooksInstalled(): boolean {
  try {
    return getAgentHookStatus().every((provider) => provider.installed) &&
      allHelmMcpHostsInstalled();
  } catch {
    return false;
  }
}

export function anyAgentIntegrationInstalled(): boolean {
  try {
    return getAgentHookStatus().some((provider) => provider.installed) ||
      mcpHostStatus().some((host) => host.installed);
  } catch {
    return false;
  }
}

/** Write hook and MCP files without printing. Used by `helm hooks install` and session-start repair. */
export function installAgentIntegrations(): ReturnType<typeof installHelmMcpHosts> {
  const claudePath = getClaudeSettingsPath();
  const codexPath = getCodexHooksPath();
  const cursorPath = getCursorHooksPath();
  const openCodePath = getOpenCodePluginPath();
  const geminiPath = getGeminiSettingsPath();
  const copilotPath = getCopilotHooksPath();
  const piPath = getPiExtensionPath();
  const ampPath = getAmpPluginPath();
  const kiloPath = getKiloPluginPath();

  // Validate every destination before writing any of them, so malformed JSON
  // or an unrelated OpenCode plugin cannot leave a partial installation.
  const claude = readClaudeSettings(claudePath);
  const codex = readCodexHooks(codexPath);
  const cursor = readCursorHooks(cursorPath);
  const gemini = readGeminiSettings(geminiPath);
  assertOpenCodePluginWritable(openCodePath);
  assertCopilotHooksWritable(copilotPath);
  assertPiExtensionWritable(piPath);
  assertAmpPluginWritable(ampPath);
  assertKiloPluginWritable(kiloPath);
  assertMcpHostsWritable();

  writeClaudeSettings(mergeHelmHooks(claude), claudePath);
  writeCodexHooks(mergeCodexHooks(codex), codexPath);
  writeCursorHooks(mergeCursorHooks(cursor), cursorPath);
  writeOpenCodePlugin(openCodePath);
  writeGeminiSettings(mergeGeminiHooks(gemini), geminiPath);
  writeCopilotHooks(copilotPath);
  writePiExtension(piPath);
  writeAmpPlugin(ampPath);
  writeKiloPlugin(kiloPath);
  return installHelmMcpHosts();
}

export async function hooksInstallCommand(): Promise<void> {
  const mcpHosts = installAgentIntegrations();

  console.log(chalk.green("\n✓ Installed Helm agent integrations"));
  for (const { name, path, derivedFrom, runtimeDetected } of getAgentHookStatus()) {
    const suffix = derivedFrom ? ` via ${derivedFrom}` : path;
    const readiness = runtimeDetected ? "" : " (ready when installed)";
    console.log(chalk.gray(`  ${name.padEnd(12)} ${suffix}${readiness}`));
  }
  for (const host of mcpHosts) {
    console.log(chalk.gray(`  ${host.name.padEnd(12)} ${host.path}`));
  }
  console.log(
    chalk.gray(
      "\n  Shared team context is now available in all supported coding agents above.\n" +
        "  Hooks fail open — Helm being unavailable never blocks an agent session.\n",
    ),
  );
  const pending = getUnsupportedAgentRecommendations().filter((agent) => agent.detected);
  if (pending.length > 0) {
    console.log(chalk.yellow("  Detected agents not changed automatically:"));
    for (const agent of pending) {
      console.log(chalk.gray(`    ${agent.name}: ${agent.recommendation}`));
    }
    console.log("");
  }
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
  const geminiPath = getGeminiSettingsPath();
  const copilotPath = getCopilotHooksPath();
  const piPath = getPiExtensionPath();
  const ampPath = getAmpPluginPath();
  const kiloPath = getKiloPluginPath();

  const claude = readClaudeSettings(claudePath);
  const codex = readCodexHooks(codexPath);
  const cursor = readCursorHooks(cursorPath);
  const gemini = readGeminiSettings(geminiPath);
  assertMcpHostsWritable();

  writeClaudeSettings(removeHelmHooks(claude), claudePath);
  writeCodexHooks(removeCodexHooks(codex), codexPath);
  writeCursorHooks(removeCursorHooks(cursor), cursorPath);
  removeOpenCodePlugin(openCodePath);
  writeGeminiSettings(removeGeminiHooks(gemini), geminiPath);
  removeCopilotHooks(copilotPath);
  removePiExtension(piPath);
  removeAmpPlugin(ampPath);
  removeKiloPlugin(kiloPath);
  uninstallHelmMcpHosts();
  console.log(chalk.green("\n✓ Removed Helm agent integrations\n"));
}

export interface HooksStatusOptions {
  json?: boolean;
}

export async function hooksStatusCommand(options: HooksStatusOptions = {}): Promise<void> {
  let statuses: AgentHookStatus[];
  try {
    statuses = getAgentHookStatus();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      console.log(JSON.stringify({ error: message }));
      process.exitCode = 1;
    } else {
      console.log(chalk.yellow(`\n${message}\n`));
    }
    return;
  }
  const recommendations = getUnsupportedAgentRecommendations().filter((agent) => agent.detected);
  let mcpHosts: ReturnType<typeof mcpHostStatus> = [];
  try {
    mcpHosts = mcpHostStatus();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      console.log(JSON.stringify({ error: message }));
      process.exitCode = 1;
    } else {
      console.log(chalk.yellow(`\n${message}\n`));
    }
    return;
  }
  if (options.json) {
    console.log(JSON.stringify({
      allInstalled: statuses.every((provider) => provider.installed) &&
        mcpHosts.every((host) => host.installed),
      integrations: statuses,
      mcp: mcpHosts,
      recommendations,
    }));
    return;
  }
  console.log("");
  for (const provider of statuses) {
    const icon = provider.installed ? chalk.green("✓") : chalk.gray("○");
    const detail = provider.derivedFrom ? `via ${provider.derivedFrom}` : provider.path;
    const readiness = provider.runtimeDetected ? "" : " (runtime not detected; ready when installed)";
    console.log(`  ${icon} ${provider.name.padEnd(12)} ${chalk.gray(`${detail}${readiness}`)}`);
  }
  for (const host of mcpHosts) {
    const icon = host.installed ? chalk.green("✓") : chalk.gray("○");
    console.log(`  ${icon} ${host.name.padEnd(12)} ${chalk.gray(host.path)}`);
  }
  if (recommendations.length > 0) {
    console.log(chalk.yellow("\n  Detected but not automatically configured:"));
    for (const agent of recommendations) {
      console.log(chalk.gray(`    ${agent.name}: ${agent.recommendation}`));
    }
  }
  if (!statuses.every((provider) => provider.installed) || !mcpHosts.every((host) => host.installed)) {
    console.log(chalk.gray("\n  Run `helm hooks install` to install missing integrations.\n"));
  } else {
    console.log("");
  }
}
