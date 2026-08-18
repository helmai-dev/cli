/**
 * Surgical install of Helm's stdio MCP server into Claude Code and Cursor
 * user-level MCP configs. Other mcpServers entries are left untouched.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveHelmMcpSpawn } from "./daemon-spawn.js";

export const HELM_MCP_CONFIG_KEY = "helm";

export interface McpServerEntry {
  command?: string;
  args?: string[];
  [key: string]: unknown;
}

export interface McpHostConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

export interface HelmMcpHostStatus {
  name: string;
  path: string;
  installed: boolean;
}

export function getClaudeMcpConfigPath(): string {
  return path.join(os.homedir(), ".claude.json");
}

export function getCursorMcpConfigPath(): string {
  return path.join(os.homedir(), ".cursor", "mcp.json");
}

export function helmMcpServerEntry(
  execPath: string = process.execPath,
  entryScript: string | undefined | null = process.argv[1],
): McpServerEntry {
  const plan = resolveHelmMcpSpawn(execPath, entryScript);
  if (!plan) {
    return { command: "helm", args: ["mcp"] };
  }
  return { command: plan.command, args: plan.args };
}

export function mergeHelmMcpServer(
  config: McpHostConfig,
  entry: McpServerEntry = helmMcpServerEntry(),
): McpHostConfig {
  return {
    ...config,
    mcpServers: {
      ...(config.mcpServers ?? {}),
      [HELM_MCP_CONFIG_KEY]: {
        ...(config.mcpServers?.[HELM_MCP_CONFIG_KEY] ?? {}),
        ...entry,
      },
    },
  };
}

export function removeHelmMcpServer(config: McpHostConfig): McpHostConfig {
  if (!config.mcpServers || !Object.hasOwn(config.mcpServers, HELM_MCP_CONFIG_KEY)) {
    return config;
  }
  const mcpServers = { ...config.mcpServers };
  delete mcpServers[HELM_MCP_CONFIG_KEY];
  const next: McpHostConfig = { ...config };
  if (Object.keys(mcpServers).length > 0) {
    next.mcpServers = mcpServers;
  } else {
    next.mcpServers = {};
  }
  return next;
}

export function helmMcpServerInstalled(config: McpHostConfig): boolean {
  const entry = config.mcpServers?.[HELM_MCP_CONFIG_KEY];
  if (!entry || typeof entry.command !== "string" || entry.command.length === 0) {
    return false;
  }
  return Array.isArray(entry.args) && entry.args.includes("mcp");
}

export function readMcpHostConfig(configPath: string): McpHostConfig {
  if (!fs.existsSync(configPath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8")) as McpHostConfig;
  } catch {
    throw new Error(
      `${configPath} is not valid JSON — refusing to modify it. Fix the file and retry.`,
    );
  }
}

export function writeMcpHostConfig(config: McpHostConfig, configPath: string): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

export function installHelmMcpHosts(input: {
  claudePath?: string;
  cursorPath?: string;
  entry?: McpServerEntry;
} = {}): HelmMcpHostStatus[] {
  const entry = input.entry ?? helmMcpServerEntry();
  const claudePath = input.claudePath ?? getClaudeMcpConfigPath();
  const cursorPath = input.cursorPath ?? getCursorMcpConfigPath();
  const claude = readMcpHostConfig(claudePath);
  const cursor = readMcpHostConfig(cursorPath);
  writeMcpHostConfig(mergeHelmMcpServer(claude, entry), claudePath);
  writeMcpHostConfig(mergeHelmMcpServer(cursor, entry), cursorPath);
  return mcpHostStatus({ claudePath, cursorPath });
}

export function uninstallHelmMcpHosts(input: {
  claudePath?: string;
  cursorPath?: string;
} = {}): HelmMcpHostStatus[] {
  const claudePath = input.claudePath ?? getClaudeMcpConfigPath();
  const cursorPath = input.cursorPath ?? getCursorMcpConfigPath();
  if (fs.existsSync(claudePath)) {
    writeMcpHostConfig(removeHelmMcpServer(readMcpHostConfig(claudePath)), claudePath);
  }
  if (fs.existsSync(cursorPath)) {
    writeMcpHostConfig(removeHelmMcpServer(readMcpHostConfig(cursorPath)), cursorPath);
  }
  return mcpHostStatus({ claudePath, cursorPath });
}

export function mcpHostStatus(input: {
  claudePath?: string;
  cursorPath?: string;
} = {}): HelmMcpHostStatus[] {
  const claudePath = input.claudePath ?? getClaudeMcpConfigPath();
  const cursorPath = input.cursorPath ?? getCursorMcpConfigPath();
  return [
    {
      name: "Claude MCP",
      path: claudePath,
      installed: helmMcpServerInstalled(readMcpHostConfig(claudePath)),
    },
    {
      name: "Cursor MCP",
      path: cursorPath,
      installed: helmMcpServerInstalled(readMcpHostConfig(cursorPath)),
    },
  ];
}

export function allHelmMcpHostsInstalled(input: {
  claudePath?: string;
  cursorPath?: string;
} = {}): boolean {
  try {
    return mcpHostStatus(input).every((host) => host.installed);
  } catch {
    return false;
  }
}
