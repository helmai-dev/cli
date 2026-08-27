/**
 * Slice-6 team work excerpts (2026-08-21 excerpt lock). The wrap stores and
 * POSTs bounded excerpts — the last user ask plus tool-result bytes already
 * on the request. Agents can retrieve them through Helm's MCP tools. Never
 * whole transcripts, system/developer messages, credentials, or wrap tokens.
 */

import {
  type ToolResultEntry,
  type ToolResultPayload,
  type WorkKey,
} from "./proxy-work-cache.js";
import type { UsageExcerptUploadBody } from "./api-web.js";

/** Prompt excerpt stays below the 64k tool cap so dashboards stay readable. */
export const PROMPT_EXCERPT_MAX_CHARS = 32_000;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageText(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (isPlainRecord(block) && block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }
  return null;
}

/**
 * Most recent user-role message that carries real text. Tool-result turns are
 * skipped (they are already captured as tool excerpts); system and developer
 * messages are never excerpted. The dashboard ask is the user's own words.
 */
export function lastUserPromptFromRequestBody(parsed: unknown): string | null {
  if (!isPlainRecord(parsed) || !Array.isArray(parsed.messages)) {
    return null;
  }
  for (let index = parsed.messages.length - 1; index >= 0; index--) {
    const message = parsed.messages[index];
    if (!isPlainRecord(message) || message.role !== "user") {
      continue;
    }
    const text = messageText(message.content);
    if (text !== null && text.trim() !== "") {
      return text.slice(0, PROMPT_EXCERPT_MAX_CHARS);
    }
  }
  return null;
}

export interface ExcerptUploadParts {
  readonly workKey: WorkKey;
  readonly sessionKey: string | null;
  readonly prompt: string | null;
  readonly payload: ToolResultPayload | null;
  readonly costUsd: number | null;
  /** Original-work model and token counts observed at this intercept. */
  readonly model: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly occurredAt: Date;
  readonly environment: string | null;
}

function toolEntriesFromPayload(payload: ToolResultPayload | null): ToolResultEntry[] | null {
  if (!payload || payload.results.length === 0) {
    return null;
  }
  return payload.results.map((result) => ({
    tool_name: result.tool_name,
    path_hint: result.path_hint,
    content: result.content,
  }));
}

export function excerptUploadFromParts(
  input: ExcerptUploadParts,
): UsageExcerptUploadBody["excerpt"] {
  return {
    project_hint: input.workKey.project_hint,
    path_hints: [...input.workKey.path_hints],
    tool_names: [...input.workKey.tool_names],
    session_key: input.sessionKey !== null && input.sessionKey !== "" ? input.sessionKey : null,
    prompt_excerpt: input.prompt,
    tool_excerpts: toolEntriesFromPayload(input.payload),
    cost_usd: input.costUsd,
    model: input.model,
    input_tokens: input.inputTokens,
    output_tokens: input.outputTokens,
    cache_write_tokens: input.cacheWriteTokens,
    cache_read_tokens: input.cacheReadTokens,
    occurred_at: input.occurredAt.toISOString(),
    environment: input.environment ?? null,
  };
}
