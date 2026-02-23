/**
 * OpenCode plugin installer for Helm.
 *
 * Writes a self-contained plugin to ~/.config/opencode/plugins/helm.ts
 * and ensures @opencode-ai/plugin is listed as a dependency.
 *
 * The plugin provides:
 *   - Auto-inject: piggybacks Helm context onto the first tool call's result
 *   - Capture: tracks messages via message.updated, runs `helm capture` on session.idle
 *   - Compaction context: injects team rules from harbor.json during compaction
 *   - Fallback tool: `helm_context` for explicit injection (tool-less conversations)
 *   - Shell env: passes HELM_* vars to all shell commands
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const PLUGIN_VERSION = '1.1.0';

function getPluginContent(): string {
  return `/**
 * Helm plugin for OpenCode — auto-installed by \`helm init\`
 * Version: ${PLUGIN_VERSION}
 *
 * Bidirectional sync between Helm and OpenCode:
 *
 *   1. Auto-inject (tool.execute.after)
 *      After the first user message, the next tool call gets Helm context
 *      appended to its result. The AI sees team rules, recommendations, and
 *      project context alongside the tool output — no explicit tool call needed.
 *
 *   2. Capture (session.idle)
 *      When the AI finishes responding, the plugin captures the exchange
 *      for Helm analytics and team dashboards.
 *
 *   3. Compaction (experimental.session.compacting)
 *      Team rules from harbor.json persist across session compaction.
 *
 *   4. Fallback tool (helm_context)
 *      For conversations without tool calls, the AI can call this explicitly.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

export const HelmPlugin: Plugin = async ({ directory }) => {
  let lastUserPrompt = ""
  let lastAssistantResponse = ""
  let lastPromptId: string | null = null
  let hasInjectedThisTurn = false

  // Resolve helm binary once at startup
  const helmBin = (() => {
    try {
      const r = spawnSync("which", ["helm"], { encoding: "utf-8", timeout: 3_000 })
      return r.stdout?.trim() || "helm"
    } catch {
      return "helm"
    }
  })()

  // Check if this project has Helm initialised
  const helmDir = join(directory, ".helm")
  const isHelmProject = existsSync(helmDir)

  // --- helpers ---

  function runInject(prompt: string): string | null {
    try {
      const result = spawnSync(helmBin, ["inject"], {
        input: prompt,
        encoding: "utf-8",
        timeout: 10_000,
        cwd: directory,
      })
      if (result.status !== 0) return null

      const metaPath = join(directory, ".helm", "last-inject.json")
      if (existsSync(metaPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaPath, "utf-8"))
          lastPromptId = meta.prompt_id ?? null
        } catch {}
      }

      return result.stdout?.trim() || null
    } catch {
      return null
    }
  }

  function runCapture(response: string, promptId: string): void {
    try {
      spawnSync(helmBin, ["capture"], {
        input: response,
        encoding: "utf-8",
        timeout: 10_000,
        cwd: directory,
        env: {
          ...process.env,
          HELM_LAST_PROMPT_ID: promptId,
        },
      })
    } catch {
      // Silent — never interrupt the user
    }
  }

  function loadRules(): string {
    try {
      const harborPath = join(directory, ".helm", "harbor.json")
      if (!existsSync(harborPath)) return ""

      const harbor = JSON.parse(readFileSync(harborPath, "utf-8"))
      if (!harbor.rules || !Array.isArray(harbor.rules)) return ""

      return harbor.rules
        .map((rule: any) => {
          const sections = (rule.sections ?? [])
            .map((s: any) => \`### \${s.title}\\n\${s.content}\`)
            .join("\\n\\n")
          return \`## \${rule.title}\\n\${sections}\`
        })
        .join("\\n\\n---\\n\\n")
    } catch {
      return ""
    }
  }

  // --- hooks ---

  return {
    event: async ({ event }: { event: { type: string; [key: string]: unknown } }) => {
      if (!isHelmProject) return

      if (event.type === "message.updated") {
        const data = event as any
        const role = data.properties?.role ?? data.role
        const content = data.properties?.content ?? data.content

        const text =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content.map((p: any) => p.text ?? "").join("\\n")
              : ""

        if (role === "user" && text) {
          lastUserPrompt = text
          hasInjectedThisTurn = false // New user message — allow injection again
        }
        if (role === "assistant" && text) {
          lastAssistantResponse = text
        }
      }

      // Reset injection flag on new session
      if (event.type === "session.created") {
        hasInjectedThisTurn = false
        lastPromptId = null
        lastUserPrompt = ""
        lastAssistantResponse = ""
      }

      // Capture on session idle
      if (event.type === "session.idle") {
        if (!lastUserPrompt || !lastAssistantResponse) return

        const promptId = lastPromptId ?? runInject(lastUserPrompt)
        if (promptId) {
          runCapture(lastAssistantResponse, promptId)
        }

        lastPromptId = null
        lastUserPrompt = ""
        lastAssistantResponse = ""
      }
    },

    // Auto-inject: append Helm context to the first tool result per user turn.
    // The AI naturally sees team rules alongside the tool output.
    "tool.execute.after": async (
      _input: { tool: string; [key: string]: unknown },
      output: { result?: string; [key: string]: unknown },
    ) => {
      if (hasInjectedThisTurn || !lastUserPrompt || !isHelmProject) return

      hasInjectedThisTurn = true

      const enhanced = runInject(lastUserPrompt)
      if (!enhanced) return

      // Append Helm context to the tool's result so the AI sees it naturally
      const existing = typeof output.result === "string" ? output.result : ""
      output.result = existing +
        "\\n\\n---\\n" +
        "## Helm Context (auto-injected by Helm plugin)\\n\\n" +
        enhanced
    },

    // Inject team rules during session compaction so context persists
    "experimental.session.compacting": async (_input: unknown, output: { context: string[]; prompt?: string }) => {
      if (!isHelmProject) return

      const rules = loadRules()
      if (rules) {
        output.context.push(\`\\n## Helm Team Rules\\n\\nThe following rules are provided by the team's Helm configuration. Follow them for all work in this session.\\n\\n\${rules}\\n\`)
      }
    },

    // Pass Helm env vars into all shell commands
    "shell.env": async (_input: unknown, output: { env: Record<string, string> }) => {
      if (lastPromptId) {
        output.env.HELM_LAST_PROMPT_ID = lastPromptId
      }
      output.env.HELM_PLUGIN_ACTIVE = "1"
    },

    // Fallback tool for conversations without tool calls
    tool: {
      helm_context: tool({
        description:
          "Get Helm team rules, context, and AI recommendations for the current task. " +
          "Only call this if you have NOT already received Helm context through a tool result.",
        args: {
          prompt: tool.schema.string("Brief description of the current task"),
        },
        async execute(args: { prompt: string }) {
          hasInjectedThisTurn = true // Prevent double injection via tool.execute.after
          const result = runInject(args.prompt)
          if (result) return result
          const rules = loadRules()
          if (rules) return rules
          return "Helm context unavailable. Ensure \\\`helm init\\\` has been run in this project."
        },
      }),
    },
  }
}
`;
}

function getPluginsDir(): string {
  return path.join(os.homedir(), '.config', 'opencode', 'plugins');
}

function getConfigDir(): string {
  return path.join(os.homedir(), '.config', 'opencode');
}

export function installOpenCodePlugin(): { success: boolean; message: string } {
  const pluginsDir = getPluginsDir();
  const pluginPath = path.join(pluginsDir, 'helm.ts');

  try {
    // Ensure plugins directory exists
    fs.mkdirSync(pluginsDir, { recursive: true });

    // Write plugin file
    fs.writeFileSync(pluginPath, getPluginContent(), 'utf-8');

    // Ensure package.json has @opencode-ai/plugin dependency
    ensurePluginDependency();

    return {
      success: true,
      message: `OpenCode plugin installed at ${pluginPath}`,
    };
  } catch (err) {
    return {
      success: false,
      message: `Failed to install OpenCode plugin: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function uninstallOpenCodePlugin(): { success: boolean; message: string } {
  const pluginPath = path.join(getPluginsDir(), 'helm.ts');

  if (!fs.existsSync(pluginPath)) {
    return { success: true, message: 'OpenCode plugin not found (already removed)' };
  }

  try {
    fs.unlinkSync(pluginPath);
    return { success: true, message: 'OpenCode plugin removed' };
  } catch (err) {
    return {
      success: false,
      message: `Failed to remove OpenCode plugin: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function ensurePluginDependency(): void {
  const configDir = getConfigDir();
  const pkgPath = path.join(configDir, 'package.json');

  let pkg: Record<string, unknown> = {};
  if (fs.existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      pkg = {};
    }
  }

  const deps = (pkg.dependencies ?? {}) as Record<string, string>;

  if (!deps['@opencode-ai/plugin']) {
    deps['@opencode-ai/plugin'] = 'latest';
    pkg.dependencies = deps;

    if (!pkg.name) {
      pkg.name = 'opencode-user-plugins';
      pkg.private = true;
    }

    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf-8');
  }
}
