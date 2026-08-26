/**
 * Slice-6 team work excerpts (2026-08-21 excerpt lock). The wrap stores and
 * POSTs bounded excerpts — the last user ask plus tool-result bytes already
 * on the request — and, on a local miss, looks up a teammate's stored work.
 * Never whole transcripts, system/developer messages, credentials, or wrap
 * tokens. Every network step fails open.
 */

import {
  WORK_CACHE_WINDOW_MS,
  WORK_CACHE_KIND,
  lookupWork,
  type ToolResultEntry,
  type ToolResultPayload,
  type WorkCacheFile,
  type WorkKey,
  type WorkLookup,
  type WorkRecord,
} from "./proxy-work-cache.js";
import type {
  TeamWorkExcerptCandidate,
  UsageExcerptUploadBody,
} from "./api-web.js";

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

export type TeamWorkFetcher = (query: {
  project_hint: string;
  tool_names?: readonly string[];
}) => Promise<TeamWorkExcerptCandidate[]>;

function candidateToRecord(candidate: TeamWorkExcerptCandidate): WorkRecord | null {
  if (
    typeof candidate?.project_hint !== "string" ||
    candidate.project_hint === "" ||
    !Array.isArray(candidate.path_hints) ||
    !Array.isArray(candidate.tool_names)
  ) {
    return null;
  }
  const occurredMs = Date.parse(String(candidate.occurred_at));
  if (!Number.isFinite(occurredMs)) {
    return null;
  }
  const results =
    Array.isArray(candidate.tool_excerpts) && candidate.tool_excerpts.length > 0
      ? candidate.tool_excerpts.filter(
          (entry): entry is ToolResultEntry =>
            isPlainRecord(entry) &&
            typeof entry.tool_name === "string" &&
            entry.tool_name !== "" &&
            typeof entry.content === "string" &&
            entry.content !== "",
        )
      : [];
  if (results.length === 0) {
    return null;
  }
  return {
    project_hint: candidate.project_hint,
    path_hints: candidate.path_hints.filter((item): item is string => typeof item === "string"),
    tool_names: candidate.tool_names.filter((item): item is string => typeof item === "string"),
    session_key: typeof candidate.session_key === "string" ? candidate.session_key : "",
    model:
      typeof candidate.model === "string" && candidate.model !== "" ? candidate.model : null,
    cost_usd:
      typeof candidate.cost_usd === "number" && Number.isFinite(candidate.cost_usd)
        ? candidate.cost_usd
        : null,
    input_tokens: tokenCount(candidate.input_tokens),
    output_tokens: tokenCount(candidate.output_tokens),
    cache_write_tokens: tokenCount(candidate.cache_write_tokens),
    cache_read_tokens: tokenCount(candidate.cache_read_tokens),
    occurred_at: new Date(occurredMs).toISOString(),
    payload: { kind: "tool_results", results },
  };
}

/** Rows stored by pre-1.3.13 CLIs carry no counts; those stay null. */
function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

/**
 * Apply the exact local hit rule to team candidates: same project, overlapping
 * path set, overlapping tool set, newest match inside the window, non-empty
 * tool bytes. Reuses `lookupWork` so local and team hits can never drift.
 */
export async function teamReuseLookup(input: {
  key: WorkKey;
  now: Date;
  windowMs?: number;
  fetchTeamWork: TeamWorkFetcher;
}): Promise<WorkLookup> {
  if (input.key.project_hint === "" || input.key.tool_names.length === 0) {
    return { kind: "forward", reason: "no_facts" };
  }
  let candidates: TeamWorkExcerptCandidate[];
  try {
    candidates = await input.fetchTeamWork({
      project_hint: input.key.project_hint,
      tool_names: input.key.tool_names,
    });
  } catch {
    return { kind: "forward", reason: "no_hit" };
  }
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { kind: "forward", reason: "no_hit" };
  }
  const records: WorkRecord[] = [];
  for (const candidate of candidates) {
    const record = candidateToRecord(candidate);
    if (record !== null) {
      records.push(record);
    }
  }
  if (records.length === 0) {
    return { kind: "forward", reason: "no_payload" };
  }
  const synthetic: WorkCacheFile = { kind: WORK_CACHE_KIND, records, reuses: [] };
  return lookupWork({
    cache: synthetic,
    key: input.key,
    now: input.now,
    windowMs: input.windowMs ?? WORK_CACHE_WINDOW_MS,
  });
}
