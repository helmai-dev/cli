/** Surgical management of Helm's global Cursor hooks. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  HELM_HOOK_COMMAND,
  HELM_LEARN_HOOK_COMMAND,
  HELM_OBSERVE_HOOK_COMMAND,
  HELM_USAGE_SYNC_HOOK_COMMAND,
} from "./claude-settings.js";

interface CursorHookEntry {
  command?: string;
  [key: string]: unknown;
}

export interface CursorHooks {
  version?: number;
  hooks?: Record<string, CursorHookEntry[]>;
  [key: string]: unknown;
}

// Cursor's IDE fires all of these hooks. Cursor CLI releases have historically
// shipped subsets, so each command is independently fail-open; supported
// events still contribute without making the session depend on Helm.
const HELM_CURSOR_HOOKS = {
  sessionStart: HELM_HOOK_COMMAND,
  beforeSubmitPrompt: HELM_HOOK_COMMAND,
  postToolUse: HELM_OBSERVE_HOOK_COMMAND,
  afterAgentResponse: HELM_LEARN_HOOK_COMMAND,
  stop: HELM_LEARN_HOOK_COMMAND,
  sessionEnd: HELM_USAGE_SYNC_HOOK_COMMAND,
} as const;

export function mergeCursorHooks(config: CursorHooks): CursorHooks {
  const next: CursorHooks = {
    ...config,
    version: config.version ?? 1,
    hooks: { ...(config.hooks ?? {}) },
  };
  for (const [event, command] of Object.entries(HELM_CURSOR_HOOKS)) {
    const entries = [...(next.hooks![event] ?? [])];
    if (!entries.some((entry) => entry.command === command)) {
      entries.push({ command });
    }
    next.hooks![event] = entries;
  }
  return next;
}

export function removeCursorHooks(config: CursorHooks): CursorHooks {
  if (!config.hooks) {
    return config;
  }
  const hooks: Record<string, CursorHookEntry[]> = {};
  for (const [event, entries] of Object.entries(config.hooks)) {
    const kept = entries.filter(
      (entry) =>
        entry.command !== HELM_HOOK_COMMAND &&
        entry.command !== HELM_OBSERVE_HOOK_COMMAND &&
        entry.command !== HELM_LEARN_HOOK_COMMAND &&
        entry.command !== HELM_USAGE_SYNC_HOOK_COMMAND,
    );
    if (kept.length > 0) {
      hooks[event] = kept;
    }
  }
  const next: CursorHooks = { ...config };
  if (Object.keys(hooks).length > 0) {
    next.hooks = hooks;
  } else {
    delete next.hooks;
  }
  return next;
}

export function cursorHooksInstalled(config: CursorHooks): boolean {
  return Object.entries(HELM_CURSOR_HOOKS).every(([event, command]) =>
    (config.hooks?.[event] ?? []).some((entry) => entry.command === command)
  );
}

export function getCursorHooksPath(): string {
  return path.join(os.homedir(), ".cursor", "hooks.json");
}

export function readCursorHooks(configPath = getCursorHooksPath()): CursorHooks {
  if (!fs.existsSync(configPath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8")) as CursorHooks;
  } catch {
    throw new Error(`${configPath} is not valid JSON — refusing to modify it. Fix it and retry.`);
  }
}

export function writeCursorHooks(config: CursorHooks, configPath = getCursorHooksPath()): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}
