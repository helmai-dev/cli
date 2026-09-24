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
  dropDecisionKey,
  isDropped,
  lookupToolResult,
  recordDrops,
  sessionLastSeen,
  storeToolResult,
  toolResultKey,
  toolResultStub,
  touchSession,
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
  /** Results stubbed on this request (sticky plus new). */
  readonly dropped: number;
  /** Results Jev dropped for the first time on this request. */
  readonly newlyDropped: number;
  readonly savedChars: number;
  /** The store needs writing (drops or the conversation's last-seen time). */
  readonly changed: boolean;
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

/** Anthropic's default prompt-cache TTL; `ttl: "1h"` blocks extend it. */
export const PROMPT_CACHE_TTL_MS = 5 * 60_000;
export const PROMPT_CACHE_LONG_TTL_MS = 60 * 60_000;

/** One conversation: its first message is stable for the life of the prefix. */
export function conversationKey(body: Record<string, unknown>): string | null {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return null;
  }
  return toolResultKey(JSON.stringify([body.model ?? null, body.messages[0]]));
}

function promptCacheTtlMs(body: Record<string, unknown>): number {
  return /"ttl"\s*:\s*"1h"/.test(JSON.stringify(body.system ?? null) + JSON.stringify(body.messages ?? null))
    ? PROMPT_CACHE_LONG_TTL_MS
    : PROMPT_CACHE_TTL_MS;
}

/**
 * Stub spent tool results without costing the provider cache.
 *
 * - A result dropped once stays dropped: every turn re-stubs identical bytes,
 *   so the prefix cached after the drop keeps hitting.
 * - New drops (and the Jev call) happen only when this conversation's prompt
 *   cache has already expired from idleness. A warm cache is never broken to
 *   drop something, and warm turns add no Jev latency.
 * - A conversation this proxy has not seen counts as warm (a proxy restart
 *   mid-session must not break a live cache).
 */
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
    newlyDropped: 0,
    savedChars: 0,
    changed: false,
  };
  const session = conversationKey(input.body);
  if (session === null) {
    return unchanged;
  }
  const lastSeen = sessionLastSeen(input.store, session);
  const cold =
    lastSeen !== null && input.now.getTime() - lastSeen > promptCacheTtlMs(input.body);
  let store = touchSession(input.store, session, input.now);

  const items = collectToolContext(input.body);
  const toStub = new Map<string, ToolContextItem>();
  for (const item of items) {
    if (isDropped(store, dropDecisionKey(item.id, item.resultText))) {
      toStub.set(item.id, item);
    }
  }

  let newlyDropped = 0;
  if (cold && input.ask !== undefined) {
    const candidates = dropCandidates(items).filter((item) => !toStub.has(item.id));
    if (candidates.length > 0) {
      let decisions: readonly ToolContextDecision[] | null = null;
      try {
        decisions = await input.ask(lastUserGoal(input.body), catalogFromItems(candidates));
      } catch {
        decisions = null;
      }
      if (decisions !== null && decisions.length > 0) {
        const byId = new Map(candidates.map((item) => [item.id, item]));
        const fresh: string[] = [];
        for (const id of idsToDrop(candidates, decisions)) {
          const item = byId.get(id);
          if (item === undefined) continue;
          toStub.set(id, item);
          fresh.push(dropDecisionKey(item.id, item.resultText));
        }
        newlyDropped = fresh.length;
        store = recordDrops(store, fresh, input.now);
      }
    }
  }

  if (toStub.size === 0) {
    return { ...unchanged, store, changed: true };
  }
  const stubs = new Map<string, string>();
  let savedChars = 0;
  for (const [id, item] of toStub) {
    const stored = storeToolResult(store, {
      id: item.id,
      tool: item.tool,
      text: item.resultText,
      now: input.now,
    });
    store = stored.store;
    const stub = toolResultStub({ tool: item.tool, chars: item.resultChars, key: stored.key });
    stubs.set(id, stub);
    savedChars += Math.max(0, item.resultChars - stub.length);
  }
  return {
    body: applyToolResultStubs(input.body, stubs),
    store,
    dropped: stubs.size,
    newlyDropped,
    savedChars,
    changed: true,
  };
}

export function restoreToolResultText(
  store: ToolResultStore,
  key: string,
): string | null {
  return lookupToolResult(store, key)?.text ?? null;
}
