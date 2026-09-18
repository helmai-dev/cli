/**
 * Hidden spike hook: typed Jev Noul/Choice in → `/handoff` out.
 *
 * Not installed by `helm hooks install`. Not a dashboard plugin.
 * Fail-open. Never applies keep/drop compaction. See `docs/JEV.md`.
 */

import { readBoundedHookInput } from "../lib/hook-evidence.js";
import {
  decideHandoffNow,
  type HandoffNowDecision,
} from "../lib/jev-handoff-now.js";

export interface HandoffNowHookPayload {
  readonly session_id?: string;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly answers?: Record<string, unknown>;
}

export type HandoffNowHookResolution =
  | { readonly kind: "handoff"; readonly decision: HandoffNowDecision }
  | { readonly kind: "continue"; readonly decision?: HandoffNowDecision }
  | { readonly kind: "rejected_compaction"; readonly message: string }
  | { readonly kind: "invalid" };

export function parseHandoffNowHookPayload(
  raw: unknown,
): { answers: Record<string, unknown> } | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const answers = (raw as HandoffNowHookPayload).answers;
  if (answers === null || typeof answers !== "object" || Array.isArray(answers)) {
    return null;
  }
  return { answers };
}

export function resolveHandoffNowHook(
  parsed: { answers: Record<string, unknown> } | null,
): HandoffNowHookResolution {
  if (parsed === null) {
    return { kind: "invalid" };
  }
  const result = decideHandoffNow(parsed.answers);
  if (!result.ok) {
    if (result.error === "compaction_keep_drop") {
      return { kind: "rejected_compaction", message: result.message };
    }
    return { kind: "invalid" };
  }
  if (result.decision.action === "handoff") {
    return { kind: "handoff", decision: result.decision };
  }
  return { kind: "continue", decision: result.decision };
}

export function formatHandoffNowHookOutput(resolved: HandoffNowHookResolution): string {
  if (resolved.kind === "handoff") {
    return JSON.stringify({
      systemMessage:
        "Helm · /handoff now — about to compact or looping. Write a directory handoff and start clean.",
      additionalContext:
        "Run /handoff. Do not compact this thread and do not drop or keep tool results. Write a directory handoff (state, decisions, open work, how to resume), then start clean with /handon.",
    });
  }
  if (resolved.kind === "rejected_compaction") {
    return JSON.stringify({
      systemMessage: `Helm · ${resolved.message}`,
    });
  }
  return "";
}

export async function handoffNowCommand(): Promise<void> {
  try {
    const raw = await readBoundedHookInput();
    const payload = raw ? (JSON.parse(raw) as unknown) : null;
    const output = formatHandoffNowHookOutput(
      resolveHandoffNowHook(parseHandoffNowHookPayload(payload)),
    );
    if (output) {
      process.stdout.write(output);
    }
  } catch {
    // Detector is fail-open. A bad payload must not break the session
    // and must not fall through to compaction.
  }
}
