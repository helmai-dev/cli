/**
 * Surgical install of Helm's stdio MCP server into coding-agent host configs:
 * Claude Code (~/.claude.json), Cursor (~/.cursor/mcp.json), Codex
 * (~/.codex/config.toml), Gemini CLI (~/.gemini/settings.json), and OpenCode
 * (~/.config/opencode/opencode.json). Other servers' entries are left
 * untouched.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveHelmMcpSpawn } from "./daemon-spawn.js";
import { getGeminiSettingsPath } from "./gemini-hooks.js";

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

/** OpenCode keeps local MCP servers under a top-level `mcp` map with array commands. */
export interface OpenCodeMcpConfig {
  mcp?: Record<
    string,
    { type?: string; command?: string[]; enabled?: boolean; [key: string]: unknown }
  >;
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

export function getCodexMcpConfigPath(): string {
  return path.join(os.homedir(), ".codex", "config.toml");
}

export function getGeminiMcpConfigPath(): string {
  return getGeminiSettingsPath();
}

export function getOpenCodeMcpConfigPath(): string {
  return path.join(os.homedir(), ".config", "opencode", "opencode.json");
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

export function assertMcpHostsWritable(
  input: McpHostPaths = {},
): void {
  readMcpHostConfig(input.claudePath ?? getClaudeMcpConfigPath());
  readMcpHostConfig(input.cursorPath ?? getCursorMcpConfigPath());
  readMcpHostConfig(input.geminiPath ?? getGeminiMcpConfigPath());
  readOpenCodeMcpConfig(input.openCodePath ?? getOpenCodeMcpConfigPath());
  // Codex TOML is verified by re-parsing after each write (see writeCodexMcpSource).
}

export interface McpHostPaths {
  claudePath?: string;
  cursorPath?: string;
  codexPath?: string;
  geminiPath?: string;
  openCodePath?: string;
}

export function installHelmMcpHosts(input: McpHostPaths & { entry?: McpServerEntry } = {}): HelmMcpHostStatus[] {
  const entry = input.entry ?? helmMcpServerEntry();
  const claudePath = input.claudePath ?? getClaudeMcpConfigPath();
  const cursorPath = input.cursorPath ?? getCursorMcpConfigPath();
  const codexPath = input.codexPath ?? getCodexMcpConfigPath();
  const geminiPath = input.geminiPath ?? getGeminiMcpConfigPath();
  const openCodePath = input.openCodePath ?? getOpenCodeMcpConfigPath();

  writeMcpHostConfig(mergeHelmMcpServer(readMcpHostConfig(claudePath), entry), claudePath);
  writeMcpHostConfig(mergeHelmMcpServer(readMcpHostConfig(cursorPath), entry), cursorPath);
  writeCodexMcpSource(mergeHelmCodexMcpServer(readCodexMcpSource(codexPath), entry), codexPath);
  writeMcpHostConfig(mergeHelmMcpServer(readMcpHostConfig(geminiPath), entry), geminiPath);
  writeOpenCodeMcpConfig(
    mergeHelmOpenCodeMcp(readOpenCodeMcpConfig(openCodePath), entry),
    openCodePath,
  );
  return mcpHostStatus({ claudePath, cursorPath, codexPath, geminiPath, openCodePath });
}

export function uninstallHelmMcpHosts(input: McpHostPaths = {}): HelmMcpHostStatus[] {
  const claudePath = input.claudePath ?? getClaudeMcpConfigPath();
  const cursorPath = input.cursorPath ?? getCursorMcpConfigPath();
  const codexPath = input.codexPath ?? getCodexMcpConfigPath();
  const geminiPath = input.geminiPath ?? getGeminiMcpConfigPath();
  const openCodePath = input.openCodePath ?? getOpenCodeMcpConfigPath();

  if (fs.existsSync(claudePath)) {
    writeMcpHostConfig(removeHelmMcpServer(readMcpHostConfig(claudePath)), claudePath);
  }
  if (fs.existsSync(cursorPath)) {
    writeMcpHostConfig(removeHelmMcpServer(readMcpHostConfig(cursorPath)), cursorPath);
  }
  if (fs.existsSync(codexPath)) {
    writeCodexMcpSource(removeHelmCodexMcpServer(readCodexMcpSource(codexPath)).next, codexPath);
  }
  if (fs.existsSync(geminiPath)) {
    writeMcpHostConfig(removeHelmMcpServer(readMcpHostConfig(geminiPath)), geminiPath);
  }
  if (fs.existsSync(openCodePath)) {
    writeOpenCodeMcpConfig(
      removeHelmOpenCodeMcp(readOpenCodeMcpConfig(openCodePath)),
      openCodePath,
    );
  }
  return mcpHostStatus({ claudePath, cursorPath, codexPath, geminiPath, openCodePath });
}

export function mcpHostStatus(input: McpHostPaths = {}): HelmMcpHostStatus[] {
  const claudePath = input.claudePath ?? getClaudeMcpConfigPath();
  const cursorPath = input.cursorPath ?? getCursorMcpConfigPath();
  const codexPath = input.codexPath ?? getCodexMcpConfigPath();
  const geminiPath = input.geminiPath ?? getGeminiMcpConfigPath();
  const openCodePath = input.openCodePath ?? getOpenCodeMcpConfigPath();
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
    {
      name: "Codex MCP",
      path: codexPath,
      installed: helmCodexMcpInstalled(readCodexMcpSource(codexPath)),
    },
    {
      name: "Gemini MCP",
      path: geminiPath,
      installed: helmMcpServerInstalled(readMcpHostConfig(geminiPath)),
    },
    {
      name: "OpenCode MCP",
      path: openCodePath,
      installed: helmOpenCodeMcpInstalled(readOpenCodeMcpConfig(openCodePath)),
    },
  ];
}

export function allHelmMcpHostsInstalled(input: McpHostPaths = {}): boolean {
  try {
    return mcpHostStatus(input).every((host) => host.installed);
  } catch {
    return false;
  }
}

// --- Codex config.toml (surgical TOML section edit) ---

const CODEX_SECTION_HEADER = "[mcp_servers.helm]";

function escapeTomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function helmCodexSectionBody(entry: McpServerEntry): string {
  const command = typeof entry.command === "string" && entry.command !== "" ? entry.command : "helm";
  const args = Array.isArray(entry.args) && entry.args.length > 0 ? entry.args : ["mcp"];
  return [
    CODEX_SECTION_HEADER,
    `command = ${escapeTomlString(command)}`,
    `args = [${args.map((arg) => escapeTomlString(String(arg))).join(", ")}]`,
    "startup_timeout_sec = 5.0",
    "",
    "",
  ].join("\n");
}

function findCodexSectionBounds(source: string): { start: number; end: number } | null {
  const headerIndex = source.indexOf(CODEX_SECTION_HEADER);
  if (headerIndex === -1) {
    return null;
  }
  const lineStart =
    headerIndex > 0 && source[headerIndex - 1] !== "\n"
      ? source.lastIndexOf("\n", headerIndex) + 1
      : headerIndex;
  let end = source.length;
  const rest = source.slice(lineStart + CODEX_SECTION_HEADER.length);
  const nextSection = rest.match(/\n\[/);
  if (nextSection && nextSection.index !== undefined) {
    end = lineStart + CODEX_SECTION_HEADER.length + nextSection.index + 1;
  }
  return { start: lineStart, end };
}

export function mergeHelmCodexMcpServer(source: string, entry: McpServerEntry): string {
  const body = helmCodexSectionBody(entry);
  const bounds = findCodexSectionBounds(source);
  if (bounds === null) {
    if (source.trim() === "") {
      return `${body}`;
    }
    return source.endsWith("\n") ? `${source}\n${body}` : `${source}\n\n${body}`;
  }
  return `${source.slice(0, bounds.start)}${body}${source.slice(bounds.end)}`;
}

export function removeHelmCodexMcpServer(source: string): { next: string; removed: boolean } {
  const bounds = findCodexSectionBounds(source);
  if (bounds === null) {
    return { next: source, removed: false };
  }
  return { next: `${source.slice(0, bounds.start)}${source.slice(bounds.end)}`, removed: true };
}

function codexArgsIncludeMcp(sectionBody: string): boolean {
  const argsMatch = sectionBody.match(/args\s*=\s*\[([^\]]*)\]/);
  if (!argsMatch) {
    return false;
  }
  const values = [...argsMatch[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]);
  return values.includes("mcp");
}

export function helmCodexMcpInstalled(source: string): boolean {
  const bounds = findCodexSectionBounds(source);
  if (bounds === null) {
    return false;
  }
  const section = source.slice(bounds.start, bounds.end);
  return /command\s*=\s*"(?:[^"\\]|\\.)*"/.test(section) && codexArgsIncludeMcp(section);
}

/**
 * Read the Codex TOML as text. Missing files are treated as empty; anything
 * else is passed through untouched — our edits only ever replace the
 * `[mcp_servers.helm]` section.
 */
export function readCodexMcpSource(configPath: string): string {
  if (!fs.existsSync(configPath)) {
    return "";
  }
  return fs.readFileSync(configPath, "utf-8");
}

export function writeCodexMcpSource(source: string, configPath: string): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, source.endsWith("\n") || source === "" ? source : `${source}\n`);
  // Self-verifying write: if our section exists it must stay parseable.
  // Removing it entirely is a valid outcome and must not throw.
  const written = fs.readFileSync(configPath, "utf-8");
  const bounds = findCodexSectionBounds(written);
  if (bounds !== null && !helmCodexMcpInstalled(written)) {
    throw new Error(`${configPath} did not keep a parseable [mcp_servers.helm] section.`);
  }
}

// --- OpenCode opencode.json ---

export function readOpenCodeMcpConfig(configPath: string): OpenCodeMcpConfig {
  if (!fs.existsSync(configPath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8")) as OpenCodeMcpConfig;
  } catch {
    throw new Error(
      `${configPath} is not valid JSON — refusing to modify it. Fix the file and retry.`,
    );
  }
}

export function writeOpenCodeMcpConfig(config: OpenCodeMcpConfig, configPath: string): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

export function mergeHelmOpenCodeMcp(
  config: OpenCodeMcpConfig,
  entry: McpServerEntry = helmMcpServerEntry(),
): OpenCodeMcpConfig {
  const command = typeof entry.command === "string" ? entry.command : "helm";
  const args = Array.isArray(entry.args) ? entry.args : [];
  return {
    ...config,
    mcp: {
      ...(config.mcp ?? {}),
      [HELM_MCP_CONFIG_KEY]: {
        type: "local",
        command: [command, ...args],
        enabled: true,
      },
    },
  };
}

export function removeHelmOpenCodeMcp(config: OpenCodeMcpConfig): OpenCodeMcpConfig {
  if (!config.mcp || !Object.hasOwn(config.mcp, HELM_MCP_CONFIG_KEY)) {
    return config;
  }
  const mcp = { ...config.mcp };
  delete mcp[HELM_MCP_CONFIG_KEY];
  return { ...config, mcp };
}

export function helmOpenCodeMcpInstalled(config: OpenCodeMcpConfig): boolean {
  const entry = config.mcp?.[HELM_MCP_CONFIG_KEY];
  return Array.isArray(entry?.command) && entry!.command!.includes("mcp");
}
