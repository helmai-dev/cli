/**
 * Render an Ambient Intervention using each host's strongest native channels.
 * Visible text is never stuffed into model context except on hosts that have
 * no separate human-facing field.
 */
import type { AmbientIntervention } from "./ambient-intervention.js";

export type HostOutput =
  | "plain"
  | "claude-json"
  | "codex-json"
  | "cursor-json"
  | "gemini-json"
  | "copilot-json"
  | "plugin-json";

export interface PluginIntervention {
  additionalContext: string;
  systemMessage: string;
}

export function formatInterventionOutput(
  intervention: AmbientIntervention,
  output: HostOutput,
  eventName?: string,
): string {
  const model = intervention.modelContext;
  const visible = intervention.visibleMessage;
  if (!model && !visible) {
    switch (output) {
      case "cursor-json":
      case "copilot-json":
        return "{}";
      case "gemini-json":
        return JSON.stringify({ suppressOutput: true });
      default:
        return "";
    }
  }

  switch (output) {
    case "plain":
      return [visible, model].filter((part): part is string => Boolean(part)).join("\n\n");
    case "claude-json":
    case "codex-json": {
      const body: Record<string, unknown> = {};
      if (visible) {
        body.systemMessage = visible;
      }
      if (model) {
        body.hookSpecificOutput = {
          hookEventName: eventName ?? "SessionStart",
          additionalContext: model,
        };
      }
      return JSON.stringify(body);
    }
    case "cursor-json": {
      // Cursor's hook protocol only documents additional_context. Put the
      // short visible line first so the model can surface it, without a
      // second unofficial field that Cursor would drop.
      const additional = [visible, model].filter((part): part is string => Boolean(part)).join("\n\n");
      return JSON.stringify(additional ? { additional_context: additional } : {});
    }
    case "gemini-json": {
      const additional = [visible, model].filter((part): part is string => Boolean(part)).join("\n\n");
      return JSON.stringify({
        hookSpecificOutput: additional ? { additionalContext: additional } : undefined,
        suppressOutput: !visible,
      });
    }
    case "copilot-json": {
      const body: Record<string, unknown> = {};
      if (model) {
        body.additionalContext = model;
      }
      if (visible) {
        body.systemMessage = visible;
        if (!model) {
          body.additionalContext = visible;
        }
      }
      return JSON.stringify(body);
    }
    case "plugin-json":
      return JSON.stringify({
        additionalContext: model ?? "",
        systemMessage: visible ?? "",
      });
  }
}

export function parsePluginIntervention(stdout: string): PluginIntervention {
  const text = stdout.trim();
  if (text === "") {
    return { additionalContext: "", systemMessage: "" };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      return {
        additionalContext: typeof record.additionalContext === "string" ? record.additionalContext : "",
        systemMessage: typeof record.systemMessage === "string" ? record.systemMessage : "",
      };
    }
  } catch {
    // Older Helm returned plain context. Treat it as model-only.
  }
  return { additionalContext: text, systemMessage: "" };
}
