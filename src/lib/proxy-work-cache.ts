import * as fs from "node:fs";
import * as path from "node:path";
import { ensureHelmDir } from "./config.js";
import { buildWorkFingerprint } from "./fingerprints.js";
import { getProxyWorkCachePath } from "./proxy-state.js";
import type { InspectedToolResult, InspectedToolUse } from "./proxy-inspect.js";

export const WORK_CACHE_KIND = "helm.proxy.work.v1";
export const WORK_CACHE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_RECORDS = 64;
const MAX_RESULT_CHARS = 64_000;

export interface ToolResultEntry {
  readonly tool_name: string;
  readonly path_hint: string | null;
  readonly content: string;
}

export interface ToolResultPayload {
  readonly kind: "tool_results";
  readonly results: readonly ToolResultEntry[];
}

export interface WorkRecord {
  readonly project_hint: string;
  readonly path_hints: readonly string[];
  readonly tool_names: readonly string[];
  readonly session_key: string;
  readonly model: string | null;
  readonly cost_usd: number | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cache_write_tokens: number | null;
  readonly cache_read_tokens: number | null;
  readonly occurred_at: string;
  readonly payload: ToolResultPayload | null;
}

export interface WorkReuse {
  readonly reused_at: string;
  readonly project_hint: string;
  readonly path_hints: readonly string[];
  readonly tool_names: readonly string[];
  readonly avoided_usd: number | null;
  readonly original_occurred_at: string;
}

export interface WorkCacheFile {
  readonly kind: typeof WORK_CACHE_KIND;
  readonly records: readonly WorkRecord[];
  readonly reuses: readonly WorkReuse[];
}

export type WorkLookup =
  | { kind: "reuse"; record: WorkRecord & { payload: ToolResultPayload } }
  | { kind: "forward"; reason: "no_facts" | "no_hit" | "no_payload" };

export interface WorkKey {
  readonly project_hint: string;
  readonly path_hints: readonly string[];
  readonly tool_names: readonly string[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (value === "" || seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}

function setsOverlap(left: readonly string[], right: readonly string[]): boolean {
  if (left.length === 0 || right.length === 0) {
    return false;
  }
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

export function workKeyFromFacts(input: {
  facts: readonly InspectedToolUse[];
  cwd: string;
  homeDir: string;
  occurredAt: string;
}): WorkKey | null {
  const pathHints: string[] = [];
  const toolNames: string[] = [];
  let projectHint: string | null = null;
  for (const fact of input.facts) {
    const fingerprint = buildWorkFingerprint(
      { provider: "claude-compatible", cwd: input.cwd },
      {
        toolName: fact.toolName,
        pathCandidate: fact.pathCandidate,
        occurredAt: input.occurredAt,
      },
      input.homeDir,
    );
    if (!fingerprint) {
      continue;
    }
    projectHint = fingerprint.project_hint;
    if (fingerprint.path_hint) {
      pathHints.push(fingerprint.path_hint);
    }
    if (fingerprint.tool_name) {
      toolNames.push(fingerprint.tool_name);
    }
  }
  if (projectHint === null) {
    return null;
  }
  return {
    project_hint: projectHint,
    path_hints: uniqueStrings(pathHints),
    tool_names: uniqueStrings(toolNames),
  };
}

export function emptyWorkCache(): WorkCacheFile {
  return { kind: WORK_CACHE_KIND, records: [], reuses: [] };
}

function parseToolResultEntry(value: unknown): ToolResultEntry | null {
  if (!isPlainRecord(value) || typeof value.tool_name !== "string" || value.tool_name === "") {
    return null;
  }
  if (typeof value.content !== "string" || value.content === "") {
    return null;
  }
  if (value.path_hint !== null && typeof value.path_hint !== "string") {
    return null;
  }
  return {
    tool_name: value.tool_name,
    path_hint: typeof value.path_hint === "string" && value.path_hint !== "" ? value.path_hint : null,
    content: value.content,
  };
}

function parsePayload(value: unknown): ToolResultPayload | null {
  if (!isPlainRecord(value) || value.kind !== "tool_results" || !Array.isArray(value.results)) {
    return null;
  }
  const results: ToolResultEntry[] = [];
  for (const entry of value.results) {
    const parsed = parseToolResultEntry(entry);
    if (parsed) {
      results.push(parsed);
    }
  }
  if (results.length === 0) {
    return null;
  }
  return { kind: "tool_results", results };
}

function parseRecord(value: unknown): WorkRecord | null {
  if (!isPlainRecord(value) || typeof value.project_hint !== "string" || value.project_hint === "") {
    return null;
  }
  if (!Array.isArray(value.path_hints) || !Array.isArray(value.tool_names)) {
    return null;
  }
  if (typeof value.session_key !== "string" || value.session_key === "") {
    return null;
  }
  if (typeof value.occurred_at !== "string" || !Number.isFinite(Date.parse(value.occurred_at))) {
    return null;
  }
  const path_hints = value.path_hints.filter((item): item is string => typeof item === "string" && item !== "");
  const tool_names = value.tool_names.filter((item): item is string => typeof item === "string" && item !== "");
  const cost_usd =
    typeof value.cost_usd === "number" && Number.isFinite(value.cost_usd) ? value.cost_usd : null;
  const input_tokens =
    typeof value.input_tokens === "number" && Number.isFinite(value.input_tokens)
      ? Math.floor(value.input_tokens)
      : null;
  const output_tokens =
    typeof value.output_tokens === "number" && Number.isFinite(value.output_tokens)
      ? Math.floor(value.output_tokens)
      : null;
  const cache_write_tokens =
    typeof value.cache_write_tokens === "number" && Number.isFinite(value.cache_write_tokens)
      ? Math.floor(value.cache_write_tokens)
      : null;
  const cache_read_tokens =
    typeof value.cache_read_tokens === "number" && Number.isFinite(value.cache_read_tokens)
      ? Math.floor(value.cache_read_tokens)
      : null;
  const model =
    typeof value.model === "string" && value.model !== "" && value.model !== "unknown"
      ? value.model
      : null;
  return {
    project_hint: value.project_hint,
    path_hints,
    tool_names,
    session_key: value.session_key,
    model,
    cost_usd,
    input_tokens,
    output_tokens,
    cache_write_tokens,
    cache_read_tokens,
    occurred_at: value.occurred_at,
    payload: parsePayload(value.payload),
  };
}

function parseReuse(value: unknown): WorkReuse | null {
  if (!isPlainRecord(value) || typeof value.reused_at !== "string") {
    return null;
  }
  if (typeof value.project_hint !== "string" || typeof value.original_occurred_at !== "string") {
    return null;
  }
  if (!Array.isArray(value.path_hints) || !Array.isArray(value.tool_names)) {
    return null;
  }
  const avoided_usd =
    typeof value.avoided_usd === "number" && Number.isFinite(value.avoided_usd)
      ? value.avoided_usd
      : null;
  return {
    reused_at: value.reused_at,
    project_hint: value.project_hint,
    path_hints: value.path_hints.filter((item): item is string => typeof item === "string"),
    tool_names: value.tool_names.filter((item): item is string => typeof item === "string"),
    avoided_usd,
    original_occurred_at: value.original_occurred_at,
  };
}

export function parseWorkCache(value: unknown): WorkCacheFile {
  if (!isPlainRecord(value) || value.kind !== WORK_CACHE_KIND) {
    return emptyWorkCache();
  }
  const records = Array.isArray(value.records)
    ? value.records.map(parseRecord).filter((record): record is WorkRecord => record !== null)
    : [];
  const reuses = Array.isArray(value.reuses)
    ? value.reuses.map(parseReuse).filter((reuse): reuse is WorkReuse => reuse !== null)
    : [];
  return { kind: WORK_CACHE_KIND, records, reuses };
}

export function readWorkCache(filePath: string): WorkCacheFile {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parseWorkCache(raw);
  } catch {
    return emptyWorkCache();
  }
}

export function writeWorkCache(filePath: string, cache: WorkCacheFile): void {
  ensureHelmDir();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(cache, null, 2)}\n`);
}

export function defaultWorkCachePath(): string {
  return getProxyWorkCachePath();
}

export function lookupWork(input: {
  cache: WorkCacheFile;
  key: WorkKey | null;
  now: Date;
  windowMs?: number;
}): WorkLookup {
  if (input.key === null || input.key.tool_names.length === 0 || input.key.path_hints.length === 0) {
    return { kind: "forward", reason: "no_facts" };
  }
  const windowMs = input.windowMs ?? WORK_CACHE_WINDOW_MS;
  const nowMs = input.now.getTime();
  let latest: WorkRecord | null = null;
  for (const record of input.cache.records) {
    if (record.project_hint !== input.key.project_hint) {
      continue;
    }
    if (!setsOverlap(record.path_hints, input.key.path_hints)) {
      continue;
    }
    if (!setsOverlap(record.tool_names, input.key.tool_names)) {
      continue;
    }
    const then = Date.parse(record.occurred_at);
    if (!Number.isFinite(then) || nowMs - then > windowMs || nowMs < then) {
      continue;
    }
    if (latest === null || Date.parse(record.occurred_at) >= Date.parse(latest.occurred_at)) {
      latest = record;
    }
  }
  if (latest === null) {
    return { kind: "forward", reason: "no_hit" };
  }
  if (latest.payload === null || latest.payload.results.length === 0) {
    return { kind: "forward", reason: "no_payload" };
  }
  return { kind: "reuse", record: { ...latest, payload: latest.payload } };
}

export function storeWork(input: {
  cache: WorkCacheFile;
  record: WorkRecord;
}): WorkCacheFile {
  return {
    kind: WORK_CACHE_KIND,
    records: [input.record, ...input.cache.records].slice(0, MAX_RECORDS),
    reuses: input.cache.reuses,
  };
}

export interface WorkReuseSummary {
  readonly count: number;
  readonly avoided_usd: number | null;
}

/** Count stored reuses. Dollars are the sum of avoided_usd that already exist.
 * Null when no reuse stored a cost. Does not invent a rate. */
export function summarizeWorkReuses(cache: WorkCacheFile): WorkReuseSummary | null {
  if (cache.reuses.length === 0) {
    return null;
  }
  let avoided: number | null = null;
  for (const reuse of cache.reuses) {
    if (reuse.avoided_usd != null) {
      avoided = (avoided ?? 0) + reuse.avoided_usd;
    }
  }
  if (avoided != null) {
    avoided = Math.round(avoided * 10000) / 10000;
  }
  return { count: cache.reuses.length, avoided_usd: avoided };
}

export function recordReuse(input: {
  cache: WorkCacheFile;
  record: WorkRecord;
  now: Date;
}): WorkCacheFile {
  const reuse: WorkReuse = {
    reused_at: input.now.toISOString(),
    project_hint: input.record.project_hint,
    path_hints: input.record.path_hints,
    tool_names: input.record.tool_names,
    avoided_usd: null,
    original_occurred_at: input.record.occurred_at,
  };
  return {
    kind: WORK_CACHE_KIND,
    records: input.cache.records,
    reuses: [reuse, ...input.cache.reuses].slice(0, MAX_RECORDS),
  };
}

export function payloadFromToolResults(input: {
  results: readonly InspectedToolResult[];
  cwd: string;
  homeDir: string;
  occurredAt: string;
}): ToolResultPayload | null {
  const mapped: ToolResultEntry[] = [];
  for (const result of input.results) {
    if (result.content.length > MAX_RESULT_CHARS) {
      continue;
    }
    const fingerprint = buildWorkFingerprint(
      { provider: "claude-compatible", cwd: input.cwd },
      {
        toolName: result.toolName,
        pathCandidate: result.pathCandidate,
        occurredAt: input.occurredAt,
      },
      input.homeDir,
    );
    mapped.push({
      tool_name: fingerprint?.tool_name ?? result.toolName,
      path_hint: fingerprint?.path_hint ?? null,
      content: result.content,
    });
  }
  if (mapped.length === 0) {
    return null;
  }
  return { kind: "tool_results", results: mapped };
}

export function reuseResponseBody(input: {
  provider: "anthropic" | "openai";
  model: string;
  payload: ToolResultPayload;
  notice: string;
}): Record<string, unknown> {
  const text = [input.notice, ...input.payload.results.map((result) => result.content)].join("\n\n");
  if (input.provider === "anthropic") {
    return {
      id: "helm_reuse",
      type: "message",
      role: "assistant",
      model: input.model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }
  return {
    id: "helm_reuse",
    object: "chat.completion",
    model: input.model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}
