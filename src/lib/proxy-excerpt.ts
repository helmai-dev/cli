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
import { sanitizeCaptureText } from "./capture-sanitization.js";
import {
  toolResultsFromRequestBody,
  type InspectedToolResult,
} from "./proxy-inspect.js";
import type { UsageExcerptUploadBody } from "./api-web.js";

/** Prompt excerpt stays below the 64k tool cap so dashboards stay readable. */
export const PROMPT_EXCERPT_MAX_CHARS = 8_000;
export const TOOL_EXCERPT_BUDGET_BYTES = 96 * 1024;
export const EXCERPT_REQUEST_BUDGET_BYTES = 256 * 1024;

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
      if (
        isPlainRecord(block) &&
        block.type === "text" &&
        typeof block.text === "string"
      ) {
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
      return sanitizeCaptureText(text, {
        maxChars: PROMPT_EXCERPT_MAX_CHARS - 1,
      });
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

/** Only the latest tool turn goes to the team store. Earlier bodies already
 * have receipts; local replay can still use the full provider request. */
export function latestExcerptToolResults(
  parsed: unknown,
): InspectedToolResult[] {
  if (!isPlainRecord(parsed) || !Array.isArray(parsed.messages)) return [];
  const messages: unknown[] = [];
  for (let i = parsed.messages.length - 1; i >= 0; i--) {
    const message = parsed.messages[i];
    if (!isPlainRecord(message)) break;
    const hasResults =
      message.role === "tool" ||
      (message.role === "user" &&
        Array.isArray(message.content) &&
        message.content.some(
          (part: unknown) => isPlainRecord(part) && part.type === "tool_result",
        ));
    if (!hasResults) break;
    messages.unshift(message);
  }
  // Keep tool-use references for naming, without including old result bodies.
  const references = parsed.messages.filter(
    (message: unknown) =>
      isPlainRecord(message) && message.role === "assistant",
  );
  return toolResultsFromRequestBody({ messages: [...references, ...messages] });
}

function toolEntriesFromPayload(
  payload: ToolResultPayload | null,
): ToolResultEntry[] | null {
  const entries: ToolResultEntry[] = [];
  const seen = new Set<string>();
  for (const result of [...(payload?.results ?? [])].reverse()) {
    if (
      /(?:^|\/)(?:\.env(?:\.[^/]*)?|id_rsa|id_ed25519|credentials(?:\.json)?)(?:$|\/)/i.test(
        result.path_hint ?? "",
      )
    )
      continue;
    const content = sanitizeCaptureText(result.content, { maxChars: 63_999 });
    if (!content) continue;
    const entry = {
      tool_name: result.tool_name.slice(0, 255),
      path_hint: result.path_hint?.slice(0, 1000) ?? null,
      content,
    };
    const key = JSON.stringify(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    if (
      Buffer.byteLength(JSON.stringify([...entries, entry]), "utf8") >
      TOOL_EXCERPT_BUDGET_BYTES
    )
      continue;
    entries.push(entry);
    if (entries.length >= 20) break;
  }
  return entries.length ? entries.reverse() : null;
}

export function excerptUploadFromParts(
  input: ExcerptUploadParts,
): UsageExcerptUploadBody["excerpt"] {
  const excerpt = {
    project_hint: input.workKey.project_hint.slice(0, 255),
    path_hints: [...input.workKey.path_hints]
      .slice(-32)
      .map((path) => path.slice(0, 1000)),
    tool_names: [...input.workKey.tool_names]
      .slice(-32)
      .map((name) => name.slice(0, 255)),
    session_key:
      input.sessionKey !== null && input.sessionKey !== ""
        ? input.sessionKey.slice(0, 64)
        : null,
    prompt_excerpt: sanitizeCaptureText(input.prompt, {
      maxChars: PROMPT_EXCERPT_MAX_CHARS - 1,
    }),
    tool_excerpts: toolEntriesFromPayload(input.payload),
    cost_usd: input.costUsd,
    model: input.model?.slice(0, 255) ?? null,
    input_tokens: input.inputTokens,
    output_tokens: input.outputTokens,
    cache_write_tokens: input.cacheWriteTokens,
    cache_read_tokens: input.cacheReadTokens,
    occurred_at: input.occurredAt.toISOString(),
    environment: input.environment?.slice(0, 255) ?? null,
  };
  while (
    Buffer.byteLength(JSON.stringify(excerpt), "utf8") >
    EXCERPT_REQUEST_BUDGET_BYTES - 1024
  ) {
    if (excerpt.path_hints.length > 1) excerpt.path_hints.shift();
    else if (excerpt.tool_names.length > 1) excerpt.tool_names.shift();
    else break;
  }
  return excerpt;
}
