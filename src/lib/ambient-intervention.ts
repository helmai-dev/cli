/**
 * One decision for every host: what the model should receive, what the human
 * should see, and whether Helm performed an action. Host adapters only format.
 *
 * Fail-open callers must treat a thrown error as silence. This module itself
 * is pure and does not I/O.
 */
import * as crypto from "node:crypto";

export type AmbientActionKind = "active" | "overlap" | "context" | "repair";

export interface AmbientAction {
  readonly kind: AmbientActionKind;
  readonly summary: string;
}

export interface AmbientIntervention {
  readonly modelContext: string | null;
  readonly visibleMessage: string | null;
  readonly actions: readonly AmbientAction[];
  readonly nextHash: string | null;
  readonly acknowledgeSession: boolean;
}

export interface AmbientDecisionInput {
  readonly renderedPack: string | null;
  readonly overlapNotice: string | null;
  readonly repairs: readonly string[];
  readonly eventName: string | undefined;
  readonly lastHash: string | null;
  readonly projectLabel: string | null;
  readonly sessionAcknowledged: boolean;
}

export function helmVisibleLine(summary: string): string {
  const trimmed = summary.trim();
  if (trimmed === "") {
    return "";
  }
  return trimmed.startsWith("Helm · ") ? trimmed : `Helm · ${trimmed}`;
}

function pushUniqueVisible(visible: string[], summary: string): void {
  const line = helmVisibleLine(summary);
  if (line === "" || visible.includes(line)) {
    return;
  }
  visible.push(line);
}

export function decideAmbientIntervention(input: AmbientDecisionInput): AmbientIntervention {
  const packHash = input.renderedPack
    ? crypto.createHash("sha1").update(input.renderedPack).digest("hex")
    : null;
  const suppressPack =
    input.eventName === "UserPromptSubmit" &&
    packHash !== null &&
    packHash === input.lastHash;
  const pack = suppressPack ? null : input.renderedPack;
  const actions: AmbientAction[] = [];
  const visible: string[] = [];
  const isSessionStart = input.eventName === "SessionStart";
  const shouldAck = isSessionStart && !input.sessionAcknowledged;

  if (shouldAck) {
    const where = input.projectLabel ? ` for ${input.projectLabel}` : "";
    const synced = pack ? " · team context synced" : "";
    const summary = `Active${where}${synced}`;
    actions.push({ kind: "active", summary });
    pushUniqueVisible(visible, summary);
  }

  for (const repair of input.repairs) {
    const summary = repair.trim();
    if (summary === "") {
      continue;
    }
    actions.push({ kind: "repair", summary });
    pushUniqueVisible(visible, summary);
  }

  if (input.overlapNotice) {
    actions.push({ kind: "overlap", summary: input.overlapNotice });
    pushUniqueVisible(visible, input.overlapNotice);
  }

  if (pack) {
    actions.push({ kind: "context", summary: "Added team context to this turn" });
    // SessionStart acknowledgement already says "team context synced".
    // Compact/resume SessionStart should not nag. UserPromptSubmit only
    // speaks when the pack actually changed (not suppressed).
    if (input.eventName === "UserPromptSubmit") {
      pushUniqueVisible(visible, "Added team context to this turn");
    }
  }

  const modelParts: string[] = [];
  if (pack) {
    modelParts.push(pack);
  }
  if (input.overlapNotice) {
    modelParts.push(input.overlapNotice);
  }

  return {
    modelContext: modelParts.length > 0 ? modelParts.join("\n\n") : null,
    visibleMessage: visible.length > 0 ? visible.join("\n") : null,
    actions,
    nextHash: packHash ?? input.lastHash,
    acknowledgeSession: shouldAck,
  };
}
