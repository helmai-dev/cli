/**
 * MCP installer: writes MCP server entries into IDE configuration files.
 *
 * Claude Code: ~/.claude.json          (mcpServers key)   project: .mcp.json
 * Cursor:      ~/.cursor/mcp.json      (mcpServers key)   project: .cursor/mcp.json
 * Windsurf:    ~/.codeium/windsurf/mcp_config.json (mcpServers key)  global only
 * OpenCode:    ~/.config/opencode/opencode.json    (mcp key, environment instead of env)  global only
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

interface OpenCodeMcpEntry {
  type: 'local';
  command: string[];
  environment?: Record<string, string>;
}

interface McpSettings {
  mcpServers?: Record<string, McpServerEntry>;
  mcp?: Record<string, OpenCodeMcpEntry>;
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

interface IdeMcpConfig {
  serversKey: 'mcpServers' | 'mcp';
  getPath: (scope: 'global' | 'project') => string;
  buildEntry: (command: string, args: string[], env: Record<string, string>) => McpServerEntry | OpenCodeMcpEntry;
}

const IDE_MCP_CONFIGS: Record<IDE, IdeMcpConfig> = {
  'claude-code': {
    serversKey: 'mcpServers',
    getPath: (scope) => scope === 'project'
      ? path.join(process.cwd(), '.mcp.json')
      : path.join(os.homedir(), '.claude.json'),
    buildEntry: (command, args, env) => {
      const entry: McpServerEntry = { command, args };
      if (Object.keys(env).length > 0) {
        entry.env = env;
      }
      return entry;
    },
  },
  'cursor': {
    serversKey: 'mcpServers',
    getPath: (scope) => scope === 'project'
      ? path.join(process.cwd(), '.cursor', 'mcp.json')
      : path.join(os.homedir(), '.cursor', 'mcp.json'),
    buildEntry: (command, args, env) => {
      const entry: McpServerEntry = { command, args };
      if (Object.keys(env).length > 0) {
        entry.env = env;
      }
      return entry;
    },
  },
  'windsurf': {
    serversKey: 'mcpServers',
    getPath: () => path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
    buildEntry: (command, args, env) => {
      const entry: McpServerEntry = { command, args };
      if (Object.keys(env).length > 0) {
        entry.env = env;
      }
      return entry;
    },
  },
  'opencode': {
    serversKey: 'mcp',
    getPath: () => path.join(os.homedir(), '.config', 'opencode', 'opencode.json'),
    buildEntry: (command, args, env) => {
      const entry: OpenCodeMcpEntry = { type: 'local', command: [command, ...args] };
      if (Object.keys(env).length > 0) {
        entry.environment = env;
      }
      return entry;
    },
  },
};

/** Parse an install_command string into command + args for the MCP server entry. */
function parseInstallCommand(installCommand: string): { command: string; args: string[] } {
  const parts = installCommand.trim().split(/\s+/);
  const command = parts[0] ?? 'npx';
  const args = parts.slice(1);
  return { command, args };
}

/** Build the MCP server entry for a given IDE, substituting config_template values. */
function buildServerEntry(
  mcp: McpDefinition,
  ide: IDE,
  apiKeyValues: Record<string, string>
): McpServerEntry | OpenCodeMcpEntry {
  const { command, args } = parseInstallCommand(mcp.install_command);

  const env: Record<string, string> = {};
  if (mcp.config_template) {
    for (const [key] of Object.entries(mcp.config_template)) {
      if (apiKeyValues[key]) {
        env[key] = apiKeyValues[key];
      }
    }
  }

  return IDE_MCP_CONFIGS[ide].buildEntry(command, args, env);
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
  const ideConfig = IDE_MCP_CONFIGS[ide];
  const filePath = ideConfig.getPath(scope);
  const settings = loadJsonFile<McpSettings>(filePath, {});
  const servers = settings[ideConfig.serversKey] as Record<string, unknown> | undefined;
  return Boolean(servers?.[mcpName]);
}

/** Return all MCPs registered in the given IDE's config file. */
export function getInstalledMcpsForIde(ide: IDE, scope: 'global' | 'project' = 'global'): string[] {
  const ideConfig = IDE_MCP_CONFIGS[ide];
  const filePath = ideConfig.getPath(scope);
  const settings = loadJsonFile<McpSettings>(filePath, {});
  const servers = settings[ideConfig.serversKey] as Record<string, unknown> | undefined;
  return Object.keys(servers ?? {});
}

/** @deprecated Use getInstalledMcpsForIde('claude-code', scope) */
export function getInstalledMcpsForClaude(scope: 'global' | 'project' = 'global'): string[] {
  return getInstalledMcpsForIde('claude-code', scope);
}

/** @deprecated Use getInstalledMcpsForIde('cursor') */
export function getInstalledMcpsForCursor(): string[] {
  return getInstalledMcpsForIde('cursor');
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
  const ideConfig = IDE_MCP_CONFIGS[ide];
  const filePath = ideConfig.getPath(scope);

  try {
    const settings = loadJsonFile<McpSettings>(filePath, {});
    const key = ideConfig.serversKey;

    if (!settings[key]) {
      (settings as Record<string, unknown>)[key] = {};
    }

    const servers = settings[key] as Record<string, unknown>;
    servers[mcp.name] = buildServerEntry(mcp, ide, apiKeyValues);
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
  const ideConfig = IDE_MCP_CONFIGS[ide];
  const filePath = ideConfig.getPath(scope);

  try {
    const settings = loadJsonFile<McpSettings>(filePath, {});
    const servers = settings[ideConfig.serversKey] as Record<string, unknown> | undefined;
    if (servers?.[mcpName]) {
      delete servers[mcpName];
      writeJsonFile(filePath, settings);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Register the Helm MCP server (`helm serve`) into detected IDE configs.
 * Called during `helm init` to make Helm tools available to agents automatically.
 */
export function installHelmMcpServer(
  ides: Array<{ name: string; detected: boolean }>,
  scope: 'global' | 'project' = 'global'
): { installed: string[]; skipped: string[] } {
  const installed: string[] = [];
  const skipped: string[] = [];

  // Resolve the helm binary — same approach as daemon.ts
  const helmBin = process.execPath;

  for (const ide of ides) {
    if (!ide.detected) continue;
    if (!(ide.name in IDE_MCP_CONFIGS)) continue;

    const ideName = ide.name as IDE;

    // Skip if already registered
    if (isMcpInstalled('helm', ideName, scope)) {
      skipped.push(ide.name);
      continue;
    }

    const ideConfig = IDE_MCP_CONFIGS[ideName];
    const filePath = ideConfig.getPath(scope);

    try {
      const settings = loadJsonFile<McpSettings>(filePath, {});
      const key = ideConfig.serversKey;

      if (!settings[key]) {
        (settings as Record<string, unknown>)[key] = {};
      }

      const servers = settings[key] as Record<string, unknown>;
      servers['helm'] = ideConfig.buildEntry(helmBin, ['serve'], {});

      writeJsonFile(filePath, settings);
      installed.push(ide.name);
    } catch {
      skipped.push(ide.name);
    }
  }

  return { installed, skipped };
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
