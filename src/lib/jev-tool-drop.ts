/**
 * Jev decides which spent tool *results* can leave the live wrap request.
 * Originals are stored on this laptop. Helm Web / TypeSafe sees a bounded
 * catalog (goal + previews), never the transcript or the full result.
 *
 * Drop only when Jev is fairly sure the verbatim bytes are no longer needed.
 * Uncertain (~0.5) and missing answers keep the result. Fail-open.
 */

import {
  applyToolResultStubs,
  collectToolContext,
  dropCandidates,
  lastUserGoal,
  type ToolContextItem,
} from "./tool-context.js";
import {
  lookupToolResult,
  storeToolResult,
  toolResultStub,
  type ToolResultStore,
} from "./tool-result-store.js";

/** Keep the result when Noul is at or above this. Below it, drop and store. */
export const KEEP_RESULT_MIN = 0.35;

export interface ToolContextCatalogItem {
  readonly id: string;
  readonly tool: string;
  readonly input_preview: string;
  readonly result_chars: number;
  readonly result_head: string;
  readonly result_tail: string;
}

export interface ToolContextDecision {
  readonly id: string;
  readonly keep_result: boolean;
  readonly noul: number | null;
}

export interface ToolContextAsker {
  ask(
    goal: string,
    tools: readonly ToolContextCatalogItem[],
  ): Promise<readonly ToolContextDecision[] | null>;
}

export interface ToolDropResult {
  readonly body: Record<string, unknown>;
  readonly store: ToolResultStore;
  readonly dropped: number;
  readonly savedChars: number;
}

const HEAD_CHARS = 240;
const TAIL_CHARS = 160;

function headTail(text: string): { head: string; tail: string } {
  if (text.length <= HEAD_CHARS + TAIL_CHARS) {
    return { head: text, tail: "" };
  }
  return {
    head: text.slice(0, HEAD_CHARS),
    tail: text.slice(text.length - TAIL_CHARS),
  };
}

export function catalogFromItems(
  items: readonly ToolContextItem[],
): ToolContextCatalogItem[] {
  return items.map((item) => {
    const slice = headTail(item.resultText);
    return {
      id: item.id,
      tool: item.tool,
      input_preview: item.inputPreview,
      result_chars: item.resultChars,
      result_head: slice.head,
      result_tail: slice.tail,
    };
  });
}

function noulFromDecision(decision: ToolContextDecision): number | null {
  if (typeof decision.noul === "number" && Number.isFinite(decision.noul)) {
    return decision.noul;
  }
  if (decision.keep_result === false) {
    return 0;
  }
  if (decision.keep_result === true) {
    return 1;
  }
  return null;
}

export function idsToDrop(
  items: readonly ToolContextItem[],
  decisions: readonly ToolContextDecision[],
): string[] {
  const byId = new Map(decisions.map((decision) => [decision.id, decision]));
  const drop: string[] = [];
  for (const item of items) {
    const decision = byId.get(item.id);
    if (decision === undefined) {
      continue;
    }
    const noul = noulFromDecision(decision);
    if (noul === null) {
      continue;
    }
    if (noul < KEEP_RESULT_MIN) {
      drop.push(item.id);
    }
  }
  return drop;
}

export async function dropSpentToolResults(input: {
  body: Record<string, unknown>;
  store: ToolResultStore;
  ask: ToolContextAsker["ask"] | undefined;
  now: Date;
}): Promise<ToolDropResult> {
  const unchanged: ToolDropResult = {
    body: input.body,
    store: input.store,
    dropped: 0,
    savedChars: 0,
  };
  if (input.ask === undefined) {
    return unchanged;
  }
  const candidates = dropCandidates(collectToolContext(input.body));
  if (candidates.length === 0) {
    return unchanged;
  }
  let decisions: readonly ToolContextDecision[] | null;
  try {
    decisions = await input.ask(lastUserGoal(input.body), catalogFromItems(candidates));
  } catch {
    return unchanged;
  }
  if (decisions === null || decisions.length === 0) {
    return unchanged;
  }
  const dropIds = idsToDrop(candidates, decisions);
  if (dropIds.length === 0) {
    return unchanged;
  }
  const byId = new Map(candidates.map((item) => [item.id, item]));
  let store = input.store;
  const stubs = new Map<string, string>();
  let savedChars = 0;
  for (const id of dropIds) {
    const item = byId.get(id);
    if (item === undefined) {
      continue;
    }
    const stored = storeToolResult(store, {
      id: item.id,
      tool: item.tool,
      text: item.resultText,
      now: input.now,
    });
    store = stored.store;
    stubs.set(id, toolResultStub({ tool: item.tool, chars: item.resultChars, key: stored.key }));
    savedChars += Math.max(0, item.resultChars - (stubs.get(id)?.length ?? 0));
  }
  if (stubs.size === 0) {
    return unchanged;
  }
  return {
    body: applyToolResultStubs(input.body, stubs),
    store,
    dropped: stubs.size,
    savedChars,
  };
}

export function restoreToolResultText(
  store: ToolResultStore,
  key: string,
): string | null {
  return lookupToolResult(store, key)?.text ?? null;
}
