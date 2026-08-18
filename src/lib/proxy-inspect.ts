import * as path from "node:path";
import {
  MAX_OTHER_NAME_CHARS,
  MAX_OTHER_PATH_CHARS,
  pathCandidateFromToolInput,
  sanitizeNoticeField,
  type WorkPathCandidate,
} from "./fingerprints.js";
import type { LiveOverlapPerson } from "./api-web.js";
import type { UsageEventUpload } from "./api-web.js";
import { formatLiveOverlapNotice } from "./live-overlap.js";

export type ProxiedProvider = "anthropic" | "openai";

export type UsageProvider = "claude" | "codex";

export interface ProviderUsage {
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
}

export interface LiveUsageRecord {
  provider: UsageProvider;
  model: string;
  project_hint: string;
  project_id: null;
  day: string;
  sessions: 1;
  calls: 1;
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  shared_context_savings_usd: null;
}

export interface InspectedToolUse {
  toolName: string;
  pathCandidate: WorkPathCandidate | null;
}

export function usageProviderFor(provider: ProxiedProvider): UsageProvider {
  return provider === "anthropic" ? "claude" : "codex";
}

export function routeProxiedProvider(input: {
  pathname: string;
  headerNames: readonly string[];
}): ProxiedProvider | null {
  const pathname = input.pathname.toLowerCase();
  if (pathname.includes("/messages") || pathname.endsWith("/complete")) {
    return "anthropic";
  }
  if (
    pathname.includes("/chat/completions") ||
    pathname.includes("/completions") ||
    pathname.includes("/responses")
  ) {
    return "openai";
  }
  const headers = new Set(input.headerNames.map((name) => name.toLowerCase()));
  if (headers.has("anthropic-version") || headers.has("anthropic-beta")) {
    return "anthropic";
  }
  if (headers.has("x-api-key") && !headers.has("authorization")) {
    return "anthropic";
  }
  if (headers.has("authorization")) {
    return "openai";
  }
  return null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function extractJsonModel(body: unknown): string {
  if (!isPlainRecord(body) || typeof body.model !== "string") {
    return "unknown";
  }
  const model = body.model.trim();
  return model === "" ? "unknown" : model;
}

function toolNameFrom(value: unknown): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : "unknown";
}

function factsFromToolInput(toolName: unknown, input: unknown): InspectedToolUse {
  return {
    toolName: toolNameFrom(toolName),
    pathCandidate: pathCandidateFromToolInput(input),
  };
}

function parseArgumentsObject(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function collectFromContent(content: unknown, out: InspectedToolUse[]): void {
  if (!Array.isArray(content)) {
    return;
  }
  for (const part of content) {
    if (!isPlainRecord(part)) {
      continue;
    }
    if (part.type === "tool_use" || part.type === "function_call") {
      const input = part.input ?? parseArgumentsObject(part.arguments);
      out.push(factsFromToolInput(part.name, input));
    }
  }
}

function collectFromMessages(messages: unknown, out: InspectedToolUse[]): void {
  if (!Array.isArray(messages)) {
    return;
  }
  for (const message of messages) {
    if (!isPlainRecord(message)) {
      continue;
    }
    collectFromContent(message.content, out);
    if (!Array.isArray(message.tool_calls)) {
      continue;
    }
    for (const call of message.tool_calls) {
      if (!isPlainRecord(call)) {
        continue;
      }
      const fn = isPlainRecord(call.function) ? call.function : call;
      out.push(factsFromToolInput(fn.name ?? call.name, parseArgumentsObject(fn.arguments)));
    }
  }
}

export function pathFactsFromRequestBody(body: unknown): InspectedToolUse[] {
  if (!isPlainRecord(body)) {
    return [];
  }
  const out: InspectedToolUse[] = [];
  collectFromMessages(body.messages, out);
  collectFromContent(body.input, out);
  return out;
}

function usageFromUnknown(provider: ProxiedProvider, payload: unknown): ProviderUsage | null {
  if (!isPlainRecord(payload)) {
    return null;
  }
  if (isPlainRecord(payload.usage)) {
    return usageFromUsageObject(provider, payload.usage);
  }
  if (isPlainRecord(payload.message) && isPlainRecord(payload.message.usage)) {
    return usageFromUsageObject(provider, payload.message.usage);
  }
  return null;
}

function usageFromUsageObject(provider: ProxiedProvider, usage: Record<string, unknown>): ProviderUsage | null {
  if (provider === "anthropic") {
    const input = finiteCount(usage.input_tokens);
    const output = finiteCount(usage.output_tokens);
    const cacheWrite = finiteCount(usage.cache_creation_input_tokens);
    const cacheRead = finiteCount(usage.cache_read_input_tokens);
    if (input === 0 && output === 0 && cacheWrite === 0 && cacheRead === 0) {
      return null;
    }
    return {
      input_tokens: input,
      output_tokens: output,
      cache_write_tokens: cacheWrite,
      cache_read_tokens: cacheRead,
    };
  }
  const details = isPlainRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : null;
  const input = finiteCount(usage.prompt_tokens ?? usage.input_tokens);
  const output = finiteCount(usage.completion_tokens ?? usage.output_tokens);
  const cacheRead = finiteCount(details?.cached_tokens ?? usage.cache_read_tokens);
  if (input === 0 && output === 0 && cacheRead === 0) {
    return null;
  }
  return {
    input_tokens: input,
    output_tokens: output,
    cache_write_tokens: 0,
    cache_read_tokens: cacheRead,
  };
}

export function usageFromProviderPayload(
  provider: ProxiedProvider,
  payload: unknown,
): ProviderUsage | null {
  return usageFromUnknown(provider, payload);
}

function mergeUsage(left: ProviderUsage | null, right: ProviderUsage | null): ProviderUsage | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return {
    input_tokens: Math.max(left.input_tokens, right.input_tokens),
    output_tokens: Math.max(left.output_tokens, right.output_tokens),
    cache_write_tokens: Math.max(left.cache_write_tokens, right.cache_write_tokens),
    cache_read_tokens: Math.max(left.cache_read_tokens, right.cache_read_tokens),
  };
}

export function usageFromSseStream(provider: ProxiedProvider, text: string): ProviderUsage | null {
  let latest: ProviderUsage | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const data = line.slice(5).trim();
    if (data === "" || data === "[DONE]") {
      continue;
    }
    try {
      latest = mergeUsage(latest, usageFromUnknown(provider, JSON.parse(data) as unknown));
    } catch {
    }
  }
  return latest;
}

export function formatTeammateNote(
  others: readonly Pick<LiveOverlapPerson, "name" | "path_hint" | "occurred_at">[],
  now: Date,
): string | null {
  const safe: LiveOverlapPerson[] = [];
  for (const other of others) {
    const name = sanitizeNoticeField(other.name, MAX_OTHER_NAME_CHARS);
    if (name === null) {
      continue;
    }
    const rawPath = other.path_hint && other.path_hint !== "" ? path.basename(other.path_hint) : null;
    const pathHint = rawPath === null ? null : sanitizeNoticeField(rawPath, MAX_OTHER_PATH_CHARS);
    if (rawPath !== null && pathHint === null) {
      continue;
    }
    if (typeof other.occurred_at !== "string" || !Number.isFinite(Date.parse(other.occurred_at))) {
      continue;
    }
    safe.push({
      name,
      project_hint: "project",
      path_hint: pathHint,
      occurred_at: other.occurred_at,
    });
  }
  return formatLiveOverlapNotice(safe, now);
}

export function isLoopbackBind(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1" || normalized === "[::1]";
}

function appendSystemText(system: unknown, note: string): unknown[] {
  const block = { type: "text", text: note };
  if (typeof system === "string") {
    return [{ type: "text", text: system }, block];
  }
  if (Array.isArray(system)) {
    return [...system, block];
  }
  return [block];
}

export function appendInterceptNote(
  provider: ProxiedProvider,
  body: unknown,
  note: string,
): Record<string, unknown> {
  const record = isPlainRecord(body) ? { ...body } : {};
  if (provider === "anthropic") {
    record.system = appendSystemText(record.system, note);
    return record;
  }
  if (typeof record.instructions === "string") {
    record.instructions = `${record.instructions}\n${note}`;
    return record;
  }
  if (Array.isArray(record.messages)) {
    record.messages = [{ role: "system", content: note }, ...record.messages];
    return record;
  }
  if (Array.isArray(record.input)) {
    record.input = [{ role: "system", content: note }, ...record.input];
    return record;
  }
  record.instructions = note;
  return record;
}

export function buildLiveUsageRecord(input: {
  provider: UsageProvider;
  model: string;
  projectHint: string;
  usage: ProviderUsage;
  day: string;
  costUsd: number;
}): LiveUsageRecord {
  return {
    provider: input.provider,
    model: input.model,
    project_hint: input.projectHint,
    project_id: null,
    day: input.day,
    sessions: 1,
    calls: 1,
    input_tokens: input.usage.input_tokens,
    output_tokens: input.usage.output_tokens,
    cache_write_tokens: input.usage.cache_write_tokens,
    cache_read_tokens: input.usage.cache_read_tokens,
    cost_usd: input.costUsd,
    shared_context_savings_usd: null,
  };
}

export function liveUsageToUpload(record: LiveUsageRecord): UsageEventUpload {
  return {
    provider: record.provider,
    model: record.model,
    project_hint: record.project_hint,
    project_id: null,
    day: record.day,
    sessions: 1,
    calls: 1,
    input_tokens: record.input_tokens,
    output_tokens: record.output_tokens,
    cache_write_tokens: record.cache_write_tokens,
    cache_read_tokens: record.cache_read_tokens,
    cost_usd: record.cost_usd,
  };
}

export const DEFAULT_PROXY_HOST = "127.0.0.1";
export const DEFAULT_PROXY_PORT = 8787;

export function claudeProxyUrl(host: string, port: number): string {
  return `http://${host}:${port}`;
}

export function codexProxyUrl(host: string, port: number): string {
  return `http://${host}:${port}/v1`;
}
