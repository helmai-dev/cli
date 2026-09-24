/**
 * Tokens Helm kept out of one wrapped request, for `helm_activity.savings`.
 *
 * Counts only. Helm Web prices them as an estimate; they never become a
 * Verified Saving. Tool-drop and deferred-schema sizes are bytes converted
 * with the measured tokens-per-byte ratio when one exists, else bytes/4.
 */

import {
  HELM_SAVINGS_TOKENS_MAX,
  type HelmActivitySavings,
} from "./api-web.js";
import { estimateTokens } from "./tokenizer.js";

const MAX_COUNT_BLOCKS = 1000;
const MAX_DEFERRED_TOOLS = 2000;

function clamp(value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(max, Math.round(value));
}

export function tokensForBytes(bytes: number, tokensPerByte: number | null): number {
  if (bytes <= 0) return 0;
  return tokensPerByte !== null && tokensPerByte > 0
    ? Math.round(bytes * tokensPerByte)
    : estimateTokens(bytes);
}

/**
 * Anthropic tool definitions the agent marked `defer_loading` (Claude Code
 * tool search). The provider keeps their schemas out of the model context
 * until searched, so their size is context the prompt did not carry.
 */
export function deferredToolSchemas(
  provider: "anthropic" | "openai",
  body: Record<string, unknown> | null,
): { count: number; bytes: number } {
  if (provider !== "anthropic" || body === null || !Array.isArray(body.tools)) {
    return { count: 0, bytes: 0 };
  }
  let count = 0;
  let bytes = 0;
  for (const tool of body.tools) {
    if (typeof tool !== "object" || tool === null) continue;
    if ((tool as Record<string, unknown>).defer_loading !== true) continue;
    count += 1;
    bytes += Buffer.byteLength(JSON.stringify(tool), "utf8");
  }
  return { count, bytes };
}

export function buildTrimSavings(input: {
  compression: { savedTokens: number; tokensExact: boolean; blocks: number } | null;
  toolDrop: { dropped: number; savedChars: number } | null;
  deferred: { count: number; bytes: number };
  tokensPerByte: number | null;
}): HelmActivitySavings | undefined {
  const compression =
    input.compression && input.compression.savedTokens > 0
      ? {
          saved_tokens: clamp(input.compression.savedTokens, HELM_SAVINGS_TOKENS_MAX),
          tokens_exact: input.compression.tokensExact,
          blocks: clamp(input.compression.blocks, MAX_COUNT_BLOCKS),
        }
      : null;
  const toolDrop =
    input.toolDrop && input.toolDrop.dropped > 0
      ? {
          dropped_results: clamp(input.toolDrop.dropped, MAX_COUNT_BLOCKS),
          saved_tokens: clamp(
            tokensForBytes(input.toolDrop.savedChars, input.tokensPerByte),
            HELM_SAVINGS_TOKENS_MAX,
          ),
        }
      : null;
  const toolSearch =
    input.deferred.count > 0
      ? {
          deferred_tools: clamp(input.deferred.count, MAX_DEFERRED_TOOLS),
          deferred_tokens: clamp(
            tokensForBytes(input.deferred.bytes, input.tokensPerByte),
            HELM_SAVINGS_TOKENS_MAX,
          ),
        }
      : null;
  if (compression === null && toolDrop === null && toolSearch === null) {
    return undefined;
  }
  return { compression, tool_drop: toolDrop, tool_search: toolSearch };
}
