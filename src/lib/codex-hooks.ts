/** Surgical management of Helm's user-level Codex lifecycle hooks. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  HELM_HOOK_COMMAND,
  HELM_LEARN_HOOK_COMMAND,
  HELM_OBSERVE_HOOK_COMMAND,
  HELM_USAGE_SYNC_HOOK_COMMAND,
} from "./claude-settings.js";

export const HELM_CODEX_INJECT_COMMAND = "helm inject --format codex";
export const HELM_CODEX_LEARN_COMMAND = `${HELM_LEARN_HOOK_COMMAND} --format codex`;

interface HookEntry {
  type: string;
  command?: string;
  [key: string]: unknown;
}

interface HookMatcher {
  matcher?: string;
  hooks?: HookEntry[];
  [key: string]: unknown;
}

export interface CodexHooks {
  description?: string;
  hooks?: Record<string, HookMatcher[]>;
  [key: string]: unknown;
}

const HELM_CODEX_HOOKS = {
  SessionStart: { command: HELM_CODEX_INJECT_COMMAND, statusMessage: "Helm" },
  UserPromptSubmit: { command: HELM_CODEX_INJECT_COMMAND, statusMessage: "Helm" },
  PostToolUse: { command: HELM_OBSERVE_HOOK_COMMAND, timeout: 2 },
  Stop: { command: HELM_CODEX_LEARN_COMMAND, timeout: 3 },
  SessionEnd: { command: HELM_USAGE_SYNC_HOOK_COMMAND, timeout: 3 },
} as const;

function matcherHasCommand(matcher: HookMatcher, command: string): boolean {
  return Array.isArray(matcher.hooks) &&
    matcher.hooks.some((entry) => entry.type === "command" && entry.command === command);
}

function isHelmEntry(entry: HookEntry): boolean {
  return entry.type === "command" &&
    (entry.command === HELM_CODEX_INJECT_COMMAND ||
      entry.command === HELM_HOOK_COMMAND ||
      entry.command === HELM_OBSERVE_HOOK_COMMAND ||
      entry.command === HELM_CODEX_LEARN_COMMAND ||
      entry.command === HELM_USAGE_SYNC_HOOK_COMMAND);
}

export function mergeCodexHooks(config: CodexHooks): CodexHooks {
  const cleaned = removeCodexHooks(config);
  const next: CodexHooks = { ...cleaned, hooks: { ...(cleaned.hooks ?? {}) } };
  for (const [event, definition] of Object.entries(HELM_CODEX_HOOKS)) {
    const matchers = [...(next.hooks![event] ?? [])];
    if (!matchers.some((matcher) => matcherHasCommand(matcher, definition.command))) {
      matchers.push({ hooks: [{ type: "command", ...definition }] });
    }
    next.hooks![event] = matchers;
  }
  return next;
}

export function removeCodexHooks(config: CodexHooks): CodexHooks {
  if (!config.hooks) {
    return config;
  }
  const hooks: Record<string, HookMatcher[]> = {};
  for (const [event, matchers] of Object.entries(config.hooks)) {
    const kept = matchers
      .map((matcher) => {
        if (!Array.isArray(matcher.hooks)) {
          return matcher;
        }
        const remaining = matcher.hooks.filter((entry) => !isHelmEntry(entry));
        return remaining.length === matcher.hooks.length
          ? matcher
          : { ...matcher, hooks: remaining };
      })
      .filter((matcher) => !Array.isArray(matcher.hooks) || matcher.hooks.length > 0);
    if (kept.length > 0) {
      hooks[event] = kept;
    }
  }
  const next: CodexHooks = { ...config };
  if (Object.keys(hooks).length > 0) {
    next.hooks = hooks;
  } else {
    delete next.hooks;
  }
  return next;
}

export function codexHooksInstalled(config: CodexHooks): boolean {
  return Object.entries(HELM_CODEX_HOOKS).every(([event, definition]) =>
    (config.hooks?.[event] ?? []).some((matcher) =>
      matcherHasCommand(matcher, definition.command)
    )
  );
}

export function getCodexHooksPath(): string {
  return path.join(os.homedir(), ".codex", "hooks.json");
}

export function readCodexHooks(configPath = getCodexHooksPath()): CodexHooks {
  if (!fs.existsSync(configPath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8")) as CodexHooks;
  } catch {
    throw new Error(`${configPath} is not valid JSON — refusing to modify it. Fix it and retry.`);
  }
}

export function writeCodexHooks(config: CodexHooks, configPath = getCodexHooksPath()): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}
