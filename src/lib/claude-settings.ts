/**
 * Installs Helm's zero-touch context hooks into Claude Code's user-scope
 * settings (~/.claude/settings.json). Context is injected while the session is
 * active, bounded tool evidence is captured locally, completed turns become
 * reviewable team-learning candidates, and aggregate usage is synced:
 *
 *  - SessionStart      → inject the full project context pack
 *  - UserPromptSubmit  → inject a delta digest (inject dedupes by content
 *                        hash per session, so unchanged context emits nothing)
 *                        and, when linked, a one-line live teammate notice
 *  - PostToolUse       → retain sanitized, bounded evidence for this turn
 *  - Stop              → submit a fail-open, review-required learning candidate
 *  - SessionEnd        → quietly scan and sync the last two days of usage
 *
 * The merge is surgical: only entries whose command matches a managed Helm
 * command are ours to add or remove; everything else in the file is preserved
 * byte-for-byte semantically. Installing twice is a no-op.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export const HELM_HOOK_COMMAND = "helm inject";
export const HELM_USAGE_SYNC_HOOK_COMMAND = "helm scan --days 2 --quiet";
export const HELM_OBSERVE_HOOK_COMMAND = "helm observe";
export const HELM_LEARN_HOOK_COMMAND = "helm learn";
const HELM_HOOKS = {
  SessionStart: HELM_HOOK_COMMAND,
  UserPromptSubmit: HELM_HOOK_COMMAND,
  PostToolUse: HELM_OBSERVE_HOOK_COMMAND,
  Stop: HELM_LEARN_HOOK_COMMAND,
  SessionEnd: HELM_USAGE_SYNC_HOOK_COMMAND,
} as const;

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

export interface ClaudeSettings {
  hooks?: Record<string, HookMatcher[]>;
  [key: string]: unknown;
}

function isHelmEntry(entry: HookEntry): boolean {
  return entry.type === "command" &&
    typeof entry.command === "string" &&
    Object.values(HELM_HOOKS).includes(entry.command as (typeof HELM_HOOKS)[keyof typeof HELM_HOOKS]);
}

function matcherHasCommand(matcher: HookMatcher, command: string): boolean {
  return Array.isArray(matcher.hooks) &&
    matcher.hooks.some((entry) => entry.type === "command" && entry.command === command);
}

/** Pure: returns a new settings object with Helm hooks present. */
export function mergeHelmHooks(settings: ClaudeSettings): ClaudeSettings {
  const next: ClaudeSettings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  for (const [event, command] of Object.entries(HELM_HOOKS)) {
    const matchers = [...(next.hooks![event] ?? [])];
    if (!matchers.some((matcher) => matcherHasCommand(matcher, command))) {
      matchers.push({ hooks: [{ type: "command", command }] });
    }
    next.hooks![event] = matchers;
  }
  return next;
}

/** Pure: returns a new settings object with Helm hooks removed, leaving all
 * other hooks (including other entries in shared matchers) untouched. */
export function removeHelmHooks(settings: ClaudeSettings): ClaudeSettings {
  if (!settings.hooks) {
    return settings;
  }
  const hooks: Record<string, HookMatcher[]> = {};
  for (const [event, matchers] of Object.entries(settings.hooks)) {
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
  const next: ClaudeSettings = { ...settings };
  if (Object.keys(hooks).length > 0) {
    next.hooks = hooks;
  } else {
    delete next.hooks;
  }
  return next;
}

export function helmHooksInstalled(settings: ClaudeSettings): boolean {
  return Object.entries(HELM_HOOKS).every(([event, command]) =>
    (settings.hooks?.[event] ?? []).some((matcher) => matcherHasCommand(matcher, command)),
  );
}

export function getClaudeSettingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

export function readClaudeSettings(settingsPath = getClaudeSettingsPath()): ClaudeSettings {
  if (!fs.existsSync(settingsPath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as ClaudeSettings;
  } catch {
    throw new Error(
      `${settingsPath} is not valid JSON — refusing to modify it. Fix the file and retry.`,
    );
  }
}

export function writeClaudeSettings(
  settings: ClaudeSettings,
  settingsPath = getClaudeSettingsPath(),
): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}
