import type { ClaudeSettings } from "./claude-settings.js";

export const ANTHROPIC_BASE_URL = "ANTHROPIC_BASE_URL";

export interface ClaudeProxyEnvResult {
  settings: ClaudeSettings;
  previous: string | undefined;
}

function envFrom(settings: ClaudeSettings): Record<string, unknown> {
  const env = settings.env;
  if (typeof env === "object" && env !== null && !Array.isArray(env)) {
    return { ...env };
  }
  return {};
}

export function mergeClaudeProxyEnv(
  settings: ClaudeSettings,
  proxyUrl: string,
): ClaudeProxyEnvResult {
  const env = envFrom(settings);
  const previous = typeof env[ANTHROPIC_BASE_URL] === "string" ? env[ANTHROPIC_BASE_URL] : undefined;
  env[ANTHROPIC_BASE_URL] = proxyUrl;
  return {
    settings: { ...settings, env },
    previous,
  };
}

export function restoreClaudeProxyEnv(
  settings: ClaudeSettings,
  previous: string | undefined,
): ClaudeSettings {
  const env = envFrom(settings);
  if (previous === undefined) {
    delete env[ANTHROPIC_BASE_URL];
  } else {
    env[ANTHROPIC_BASE_URL] = previous;
  }
  const next: ClaudeSettings = { ...settings };
  if (Object.keys(env).length === 0) {
    delete next.env;
  } else {
    next.env = env;
  }
  return next;
}
