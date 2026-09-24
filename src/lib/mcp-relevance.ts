/**
 * Per-turn MCP relevance from saved local context. ENABLE_TOOL_SEARCH already
 * defers schemas; this tells the model which connected servers this project
 * has actually used so it does not ToolSearch Crossbeam on a coding turn.
 *
 * Does not strip tools from the wrap request (that would break the provider
 * prefix cache). Fail-open. Not a verified saving.
 */

import * as os from "node:os";
import { pathHintsFromPrompt, projectHintFromCwd } from "./fingerprints.js";
import { listConnectedMcpServerNames } from "./mcp-hosts.js";
import {
  defaultWorkCachePath,
  readWorkCache,
  type WorkCacheFile,
} from "./proxy-work-cache.js";

const MAX_LIST = 8;

export interface McpRelevanceInput {
  readonly servers: readonly string[];
  readonly usedToolNames: readonly string[];
  readonly pathHint?: string;
}

export interface McpRelevanceEnvironment {
  readonly listServers: () => string[];
  readonly usedToolNames: (projectHint: string) => string[];
  readonly homeDir?: string;
}

export function toolNamesFromWorkCache(cache: WorkCacheFile, projectHint: string): string[] {
  const names = new Set<string>();
  for (const record of cache.records) {
    if (record.project_hint !== projectHint) {
      continue;
    }
    for (const name of record.tool_names) {
      if (name !== "") {
        names.add(name);
      }
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

export const liveMcpRelevanceEnvironment: McpRelevanceEnvironment = {
  listServers: () => listConnectedMcpServerNames(),
  usedToolNames: (projectHint) => {
    try {
      return toolNamesFromWorkCache(readWorkCache(defaultWorkCachePath()), projectHint);
    } catch {
      return [];
    }
  },
};

export function serverLooksUsed(server: string, usedToolNames: readonly string[]): boolean {
  const needle = server.trim().toLowerCase();
  if (needle === "") {
    return false;
  }
  if (needle === "helm") {
    return true;
  }
  return usedToolNames.some((name) => name.toLowerCase().includes(needle));
}

function takeList(values: readonly string[]): string[] {
  return values.slice(0, MAX_LIST);
}

export function renderMcpRelevanceBlock(input: McpRelevanceInput): string | null {
  const servers = unique(input.servers.map((name) => name.trim()).filter(Boolean));
  if (servers.length === 0) {
    return null;
  }
  const usedTools = unique(input.usedToolNames.map((name) => name.trim()).filter(Boolean));
  const unused = servers.filter((server) => !serverLooksUsed(server, usedTools));
  if (unused.length === 0) {
    return null;
  }

  const lines = [
    "<helm-mcp>",
    `Connected MCP servers: ${takeList(servers).join(", ")}`,
  ];
  if (usedTools.length > 0) {
    lines.push(`This project has used: ${takeList(usedTools).join(", ")}`);
  }
  if (input.pathHint) {
    lines.push(`This turn names ${input.pathHint}.`);
  }
  lines.push(
    `Do not ToolSearch or call unused servers (${takeList(unused).join(", ")}) unless the user asks. Prefer helm retrieve_team_work for paid-for work already on this project.`,
  );
  lines.push("</helm-mcp>");
  return lines.join("\n");
}

export async function maybeMcpRelevanceBlock(
  input: {
    eventName: string | undefined;
    prompt: string | null;
    cwd: string;
  },
  env: McpRelevanceEnvironment = liveMcpRelevanceEnvironment,
): Promise<string | null> {
  try {
    if (input.eventName !== "UserPromptSubmit") {
      return null;
    }
    const projectHint = projectHintFromCwd(input.cwd, env.homeDir ?? os.homedir());
    if (projectHint === null) {
      return null;
    }
    const pathHint = input.prompt ? pathHintsFromPrompt(input.prompt, input.cwd)[0] : undefined;
    return renderMcpRelevanceBlock({
      servers: env.listServers(),
      usedToolNames: env.usedToolNames(projectHint),
      pathHint,
    });
  } catch {
    return null;
  }
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(value);
  }
  return out;
}
