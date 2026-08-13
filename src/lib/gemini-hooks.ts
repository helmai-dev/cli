/** Surgical management of Gemini CLI's user-level lifecycle hooks. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HELM_USAGE_SYNC_HOOK_COMMAND } from "./claude-settings.js";

export const HELM_GEMINI_INJECT_COMMAND = "helm inject --format gemini";
export const HELM_GEMINI_OBSERVE_COMMAND = "helm observe --format gemini";
export const HELM_GEMINI_LEARN_COMMAND = "helm learn --format gemini";

interface GeminiHookCommand {
  type: string;
  command?: string;
  name?: string;
  timeout?: number;
  [key: string]: unknown;
}

interface GeminiHookMatcher {
  matcher?: string;
  sequential?: boolean;
  hooks?: GeminiHookCommand[];
  [key: string]: unknown;
}

export interface GeminiSettings {
  hooks?: Record<string, GeminiHookMatcher[]>;
  [key: string]: unknown;
}

const HELM_GEMINI_HOOKS = {
  SessionStart: HELM_GEMINI_INJECT_COMMAND,
  BeforeAgent: HELM_GEMINI_INJECT_COMMAND,
  AfterTool: HELM_GEMINI_OBSERVE_COMMAND,
  AfterAgent: HELM_GEMINI_LEARN_COMMAND,
  SessionEnd: HELM_USAGE_SYNC_HOOK_COMMAND,
} as const;

function matcherHasCommand(matcher: GeminiHookMatcher, command: string): boolean {
  return Array.isArray(matcher.hooks) && matcher.hooks.some((hook) => hook.command === command);
}

function isHelmCommand(command: string | undefined): boolean {
  return command === HELM_GEMINI_INJECT_COMMAND ||
    command === HELM_GEMINI_OBSERVE_COMMAND ||
    command === HELM_GEMINI_LEARN_COMMAND ||
    command === HELM_USAGE_SYNC_HOOK_COMMAND;
}

export function mergeGeminiHooks(settings: GeminiSettings): GeminiSettings {
  const next: GeminiSettings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  for (const [event, command] of Object.entries(HELM_GEMINI_HOOKS)) {
    const matchers = [...(next.hooks![event] ?? [])];
    if (!matchers.some((matcher) => matcherHasCommand(matcher, command))) {
      matchers.push({
        hooks: [{
          type: "command",
          command,
          name: event === "SessionEnd"
            ? "helm-usage-sync"
            : event === "AfterTool"
              ? "helm-tool-observation"
              : event === "AfterAgent"
                ? "helm-team-learning"
                : "helm-team-context",
          timeout: event === "SessionEnd" ? 3000 : event === "AfterTool" ? 1000 : 2500,
        }],
      });
    }
    next.hooks![event] = matchers;
  }
  return next;
}

export function removeGeminiHooks(settings: GeminiSettings): GeminiSettings {
  if (!settings.hooks) {
    return settings;
  }
  const hooks: Record<string, GeminiHookMatcher[]> = {};
  for (const [event, matchers] of Object.entries(settings.hooks)) {
    const kept = matchers
      .map((matcher) => {
        if (!Array.isArray(matcher.hooks)) {
          return matcher;
        }
        const remaining = matcher.hooks.filter((hook) => !isHelmCommand(hook.command));
        return remaining.length === matcher.hooks.length ? matcher : { ...matcher, hooks: remaining };
      })
      .filter((matcher) => !Array.isArray(matcher.hooks) || matcher.hooks.length > 0);
    if (kept.length > 0) {
      hooks[event] = kept;
    }
  }
  const next: GeminiSettings = { ...settings };
  if (Object.keys(hooks).length > 0) {
    next.hooks = hooks;
  } else {
    delete next.hooks;
  }
  return next;
}

export function geminiHooksInstalled(settings: GeminiSettings): boolean {
  return Object.entries(HELM_GEMINI_HOOKS).every(([event, command]) =>
    (settings.hooks?.[event] ?? []).some((matcher) => matcherHasCommand(matcher, command))
  );
}

export function getGeminiSettingsPath(): string {
  return path.join(os.homedir(), ".gemini", "settings.json");
}

export function readGeminiSettings(settingsPath = getGeminiSettingsPath()): GeminiSettings {
  if (!fs.existsSync(settingsPath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as GeminiSettings;
  } catch {
    throw new Error(`${settingsPath} is not valid JSON — refusing to modify it. Fix it and retry.`);
  }
}

export function writeGeminiSettings(
  settings: GeminiSettings,
  settingsPath = getGeminiSettingsPath(),
): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}
