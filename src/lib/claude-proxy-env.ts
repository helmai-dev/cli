import type { ClaudeSettings } from "./claude-settings.js";

export const ANTHROPIC_BASE_URL = "ANTHROPIC_BASE_URL";
export const ENABLE_TOOL_SEARCH = "ENABLE_TOOL_SEARCH";
export const HELM_ENABLE_TOOL_SEARCH = "true";

export interface ClaudeProxyEnvResult {
  settings: ClaudeSettings;
  previous: string | undefined;
  previousToolSearch: string | undefined;
}

export interface ClaudeProxyEnvSnapshot {
  anthropicBaseUrl: string | undefined;
  toolSearch?: string | undefined;
  restoreToolSearch?: boolean;
}

function envFrom(settings: ClaudeSettings): Record<string, unknown> {
  const env = settings.env;
  if (typeof env === "object" && env !== null && !Array.isArray(env)) {
    return { ...env };
  }
  return {};
}

export function claudeToolSearchEnabled(settings: ClaudeSettings): boolean {
  const env = settings.env;
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    return false;
  }
  return (env as Record<string, unknown>)[ENABLE_TOOL_SEARCH] === HELM_ENABLE_TOOL_SEARCH;
}

export function mergeClaudeProxyEnv(
  settings: ClaudeSettings,
  proxyUrl: string,
): ClaudeProxyEnvResult {
  const env = envFrom(settings);
  const previous = typeof env[ANTHROPIC_BASE_URL] === "string" ? env[ANTHROPIC_BASE_URL] : undefined;
  const previousToolSearch =
    typeof env[ENABLE_TOOL_SEARCH] === "string" ? env[ENABLE_TOOL_SEARCH] : undefined;
  env[ANTHROPIC_BASE_URL] = proxyUrl;
  // Claude Code disables MCP tool search when ANTHROPIC_BASE_URL is not
  // api.anthropic.com, so every MCP schema loads up front. Helm wrap is that
  // case. true restores on-demand loading; the proxy forwards tool_reference
  // blocks and anthropic-beta headers as-is.
  env[ENABLE_TOOL_SEARCH] = HELM_ENABLE_TOOL_SEARCH;
  return {
    settings: { ...settings, env },
    previous,
    previousToolSearch,
  };
}

export function restoreClaudeProxyEnv(
  settings: ClaudeSettings,
  snapshot: ClaudeProxyEnvSnapshot,
): ClaudeSettings {
  const env = envFrom(settings);
  if (snapshot.anthropicBaseUrl === undefined) {
    delete env[ANTHROPIC_BASE_URL];
  } else {
    env[ANTHROPIC_BASE_URL] = snapshot.anthropicBaseUrl;
  }
  if (snapshot.restoreToolSearch) {
    if (snapshot.toolSearch === undefined) {
      delete env[ENABLE_TOOL_SEARCH];
    } else {
      env[ENABLE_TOOL_SEARCH] = snapshot.toolSearch;
    }
  }
  const next: ClaudeSettings = { ...settings };
  if (Object.keys(env).length === 0) {
    delete next.env;
  } else {
    next.env = env;
  }
  return next;
}
