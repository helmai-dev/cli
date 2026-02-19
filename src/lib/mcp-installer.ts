/**
 * MCP installer: writes MCP server entries into IDE configuration files.
 *
 * Claude Code: ~/.claude/settings.json (mcpServers key)
 * Cursor:      ~/.cursor/mcp.json      (mcpServers key)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import type { McpDefinition, IDE } from '../types.js';

interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpSettings {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

export interface McpInstallResult {
  name: string;
  label: string;
  success: boolean;
  ide: IDE;
  error?: string;
  needsApiKey?: boolean;
}

/** Parse an install_command string into command + args for the MCP server entry. */
function parseInstallCommand(installCommand: string): { command: string; args: string[] } {
  // MCP install commands are typically like: "npx -y @modelcontextprotocol/server-github"
  // We split by whitespace; the first token is the command, rest are args
  const parts = installCommand.trim().split(/\s+/);
  const command = parts[0] ?? 'npx';
  const args = parts.slice(1);
  return { command, args };
}

/** Build the MCP server entry, substituting config_template values. */
function buildServerEntry(
  mcp: McpDefinition,
  apiKeyValues: Record<string, string>
): McpServerEntry {
  const { command, args } = parseInstallCommand(mcp.install_command);

  const env: Record<string, string> = {};
  if (mcp.config_template) {
    for (const [key] of Object.entries(mcp.config_template)) {
      if (apiKeyValues[key]) {
        env[key] = apiKeyValues[key];
      }
    }
  }

  const entry: McpServerEntry = { command, args };
  if (Object.keys(env).length > 0) {
    entry.env = env;
  }

  return entry;
}

function getClaudeSettingsPath(scope: 'global' | 'project' = 'global'): string {
  if (scope === 'project') {
    return path.join(process.cwd(), '.claude', 'settings.json');
  }
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function getCursorMcpPath(): string {
  return path.join(os.homedir(), '.cursor', 'mcp.json');
}

function loadJsonFile<T>(filePath: string, defaultValue: T): T {
  if (!fs.existsSync(filePath)) {
    return defaultValue;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return defaultValue;
  }
}

function writeJsonFile(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/** Check if an MCP is already registered in the IDE config. */
export function isMcpInstalled(mcpName: string, ide: IDE, scope: 'global' | 'project' = 'global'): boolean {
  const filePath = ide === 'claude-code'
    ? getClaudeSettingsPath(scope)
    : getCursorMcpPath();

  const settings = loadJsonFile<McpSettings>(filePath, {});
  return Boolean(settings.mcpServers?.[mcpName]);
}

/** Return all MCPs registered in the Claude Code settings file. */
export function getInstalledMcpsForClaude(scope: 'global' | 'project' = 'global'): string[] {
  const settings = loadJsonFile<McpSettings>(getClaudeSettingsPath(scope), {});
  return Object.keys(settings.mcpServers ?? {});
}

/** Return all MCPs registered in the Cursor MCP config file. */
export function getInstalledMcpsForCursor(): string[] {
  const settings = loadJsonFile<McpSettings>(getCursorMcpPath(), {});
  return Object.keys(settings.mcpServers ?? {});
}

/**
 * Install a single MCP into the given IDE's config file.
 * Returns whether install succeeded.
 */
export function installMcpIntoIde(
  mcp: McpDefinition,
  ide: IDE,
  apiKeyValues: Record<string, string> = {},
  scope: 'global' | 'project' = 'global'
): { success: boolean; error?: string } {
  const filePath = ide === 'claude-code'
    ? getClaudeSettingsPath(scope)
    : getCursorMcpPath();

  try {
    const settings = loadJsonFile<McpSettings>(filePath, {});
    if (!settings.mcpServers) {
      settings.mcpServers = {};
    }

    settings.mcpServers[mcp.name] = buildServerEntry(mcp, apiKeyValues);
    writeJsonFile(filePath, settings);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Remove an MCP from the given IDE's config file.
 */
export function removeMcpFromIde(
  mcpName: string,
  ide: IDE,
  scope: 'global' | 'project' = 'global'
): { success: boolean; error?: string } {
  const filePath = ide === 'claude-code'
    ? getClaudeSettingsPath(scope)
    : getCursorMcpPath();

  try {
    const settings = loadJsonFile<McpSettings>(filePath, {});
    if (settings.mcpServers?.[mcpName]) {
      delete settings.mcpServers[mcpName];
      writeJsonFile(filePath, settings);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Run the install command for an MCP (e.g., to cache the npx package locally).
 * This is optional / best-effort — the MCP will work as long as the config entry exists.
 */
export function runMcpInstallCommand(mcp: McpDefinition): { success: boolean; error?: string } {
  try {
    execSync(mcp.install_command, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
