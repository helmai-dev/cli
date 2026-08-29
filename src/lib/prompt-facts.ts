/**
 * Prompt-inefficiency detector for the wrap proxy.
 *
 * The proxy sees one HTTP request per model call, and the parsed body carries
 * the whole re-sent conversation prefix. Consecutive calls in one agent session
 * chain: turn N's `messages[]` is turn N-1's `messages[]` plus new entries. We
 * hash that prefix (never the content) to join calls into a local session, then
 * measure how much of each request was context we can prove was already sent.
 *
 * Honesty rules this file follows:
 * - No dollars. Ever. Helm Web prices measured tokens at the server rate table.
 * - `cache_read_tokens` is the provider's own statement that a re-sent prefix
 *   was served from cache at a discount. Cache-read context is NOT waste, so it
 *   is subtracted before anything is reported as re-billed.
 * - Token counts we cannot read directly are apportioned from the provider's
 *   own prompt-token total by measured byte share, and every such field carries
 *   `_apportioned` in its name. Apportionment always rounds down and is clamped
 *   to the provider's own `input_tokens`, so the reported number under-claims.
 * - Only hashes, byte lengths, and counts are persisted. No prompt text, no
 *   tool-result bytes, no system prompts, no credentials.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { ensureHelmDir } from "./config.js";
import { getProxyPromptFactsPath } from "./proxy-state.js";
import { toolResultsFromRequestBody, type ProviderUsage } from "./proxy-inspect.js";

export const PROMPT_FACTS_KIND = "helm.proxy.prompt-facts.v1";

/** Wire-format marker so Helm Web can tell which measurement build produced a row. */
export const PROMPT_FACTS_MEASUREMENT = "helm.prompt_facts.v1";

/** Chaining a longer conversation than this costs more than the signal is worth. */
export const MAX_CHAIN_MESSAGES = 2000;

const MAX_SESSIONS = 32;
const MAX_OBSERVATIONS = 250;
const MAX_ATTACHMENT_HASHES = 256;
export const PROMPT_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function mintPromptSessionKey(): string {
  return randomBytes(16).toString("hex");
}

// --- Prefix chaining ---

export interface MessageChain {
  /** `tips[i]` is the chain hash of messages[0..i]. Joins on prefix identity. */
  readonly tips: readonly string[];
  /** `cumulativeBytes[i]` is the serialized byte length of messages[0..i]. */
  readonly cumulativeBytes: readonly number[];
  readonly totalBytes: number;
}

/**
 * Rolling hash over the request's `messages[]`. Each tip commits to every
 * message before it, so `tips[k-1]` identifies "the first k messages" exactly.
 * Content is hashed and discarded; only the digests are ever kept.
 */
export function messageChainFromRequestBody(parsed: unknown): MessageChain | null {
  if (!isPlainRecord(parsed) || !Array.isArray(parsed.messages)) {
    return null;
  }
  const messages = parsed.messages;
  if (messages.length === 0 || messages.length > MAX_CHAIN_MESSAGES) {
    return null;
  }
  const tips: string[] = [];
  const cumulativeBytes: number[] = [];
  let chain = "";
  let bytes = 0;
  for (const message of messages) {
    let serialized: string;
    try {
      serialized = JSON.stringify(message) ?? "";
    } catch {
      return null;
    }
    bytes += Buffer.byteLength(serialized, "utf8");
    chain = sha256(`${chain}\0${serialized}`);
    tips.push(chain);
    cumulativeBytes.push(bytes);
  }
  return { tips, cumulativeBytes, totalBytes: bytes };
}

export interface PromptSessionState {
  readonly session_key: string;
  readonly project_hint: string;
  /** Chain hash of every message this session has already sent. */
  readonly chain_tip: string;
  readonly message_count: number;
  readonly turn_index: number;
  /** Content digests of tool results already attached in this session. */
  readonly attachment_hashes: readonly string[];
  readonly last_seen_at: string;
}

export interface PromptSessionMatch {
  readonly session: PromptSessionState;
  /** Number of leading messages this request re-sent from the matched session. */
  readonly repeatedMessageCount: number;
}

/**
 * Find the session whose already-sent messages are a prefix of this request.
 * The longest match wins so interleaved agents cannot steal each other's
 * chains. A request that extends nothing starts a new session and, correctly,
 * reports no repeated context.
 */
export function matchPromptSession(input: {
  sessions: readonly PromptSessionState[];
  projectHint: string;
  chain: MessageChain;
  now: Date;
  windowMs?: number;
}): PromptSessionMatch | null {
  const windowMs = input.windowMs ?? PROMPT_SESSION_WINDOW_MS;
  const nowMs = input.now.getTime();
  let best: PromptSessionMatch | null = null;
  for (const session of input.sessions) {
    if (session.project_hint !== input.projectHint) {
      continue;
    }
    const then = Date.parse(session.last_seen_at);
    if (!Number.isFinite(then) || nowMs - then > windowMs) {
      continue;
    }
    // A session can only be extended, never shortened: the request must carry
    // at least the messages we already saw, and their chain must match exactly.
    if (session.message_count < 1 || session.message_count > input.chain.tips.length) {
      continue;
    }
    if (input.chain.tips[session.message_count - 1] !== session.chain_tip) {
      continue;
    }
    if (best === null || session.message_count > best.repeatedMessageCount) {
      best = { session, repeatedMessageCount: session.message_count };
    }
  }
  return best;
}

// --- Repeated-attachment measurement ---

export interface AttachmentScan {
  readonly allHashes: readonly string[];
  readonly duplicateCount: number;
  readonly duplicateBytes: number;
}

function attachmentHash(content: string): string {
  return sha256(content);
}

/**
 * Tool-result payloads re-attached in the NEW part of this request whose bytes
 * were already sent earlier in the session — the same file read twice and
 * pasted in twice, not the old copy scrolling along inside the prefix. Prefix
 * repetition is measured separately, so these two never double-count.
 */
export function scanAttachments(input: {
  parsed: unknown;
  repeatedMessageCount: number;
  seenHashes: readonly string[];
}): AttachmentScan {
  const seen = new Set(input.seenHashes);
  const allHashes: string[] = [];
  for (const result of toolResultsFromRequestBody(input.parsed)) {
    allHashes.push(attachmentHash(result.content));
  }

  let duplicateCount = 0;
  let duplicateBytes = 0;
  const suffix = suffixMessages(input.parsed, input.repeatedMessageCount);
  if (suffix !== null) {
    for (const result of toolResultsFromRequestBody({ messages: suffix })) {
      if (seen.has(attachmentHash(result.content))) {
        duplicateCount += 1;
        duplicateBytes += Buffer.byteLength(result.content, "utf8");
      }
    }
  }
  return { allHashes, duplicateCount, duplicateBytes };
}

function suffixMessages(parsed: unknown, repeatedMessageCount: number): unknown[] | null {
  if (!isPlainRecord(parsed) || !Array.isArray(parsed.messages)) {
    return null;
  }
  if (repeatedMessageCount <= 0) {
    return null;
  }
  return parsed.messages.slice(repeatedMessageCount);
}

// --- The measurement ---

export interface PromptFactsMeasurement {
  /** Provider-authoritative prompt size: input + cache_write + cache_read. */
  readonly prompt_tokens_total: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_write_tokens: number;
  readonly cache_read_tokens: number;
  /** Prefix re-sent in this request, apportioned by byte share (rounds down). */
  readonly repeated_prefix_tokens_apportioned: number;
  /** Repeated prefix the provider did NOT serve from cache, so it was re-billed
   * at the full input rate. Clamped to `input_tokens`. This is the waste. */
  readonly repeated_rebilled_tokens_apportioned: number;
  /** Re-attached tool-result bytes in the new suffix, apportioned by byte share. */
  readonly duplicate_attachment_tokens_apportioned: number;
  readonly duplicate_attachment_count: number;
  readonly repeated_message_count: number;
  readonly turn_index: number;
}

/**
 * Apportion a byte share of the provider's own prompt-token total.
 *
 * We cannot count tokens for a span of text without shipping a tokenizer, so
 * the only honest option is to divide a number the provider gave us. The system
 * and tools blocks are deliberately excluded from BOTH sides of the ratio even
 * though they are re-sent verbatim every turn, which makes the result smaller
 * than the truth rather than larger.
 */
function apportion(promptTokensTotal: number, partBytes: number, totalBytes: number): number {
  if (promptTokensTotal <= 0 || totalBytes <= 0 || partBytes <= 0) {
    return 0;
  }
  const share = Math.min(1, partBytes / totalBytes);
  return Math.floor(promptTokensTotal * share);
}

export function measurePromptFacts(input: {
  usage: ProviderUsage;
  chain: MessageChain;
  repeatedMessageCount: number;
  duplicateCount: number;
  duplicateBytes: number;
  turnIndex: number;
}): PromptFactsMeasurement | null {
  const { usage } = input;
  const promptTokensTotal =
    usage.input_tokens + usage.cache_write_tokens + usage.cache_read_tokens;
  if (promptTokensTotal <= 0) {
    return null;
  }

  const repeatedBytes =
    input.repeatedMessageCount > 0
      ? (input.chain.cumulativeBytes[input.repeatedMessageCount - 1] ?? 0)
      : 0;
  const repeatedPrefix = apportion(promptTokensTotal, repeatedBytes, input.chain.totalBytes);

  // Providers cache from the start of the prompt, so cache_read always covers a
  // prefix of what we re-sent. Subtracting it is the difference between
  // "context was repeated" (normal, cheap) and "context was re-billed" (waste).
  const afterCache = Math.max(0, repeatedPrefix - usage.cache_read_tokens);
  // Nothing can be re-billed at the full input rate beyond what the provider
  // actually billed at that rate. cache_write is an investment in future reads,
  // not waste, so it is not part of the ceiling.
  const rebilled = Math.min(usage.input_tokens, afterCache);

  const duplicateApportioned = apportion(
    promptTokensTotal,
    input.duplicateBytes,
    input.chain.totalBytes,
  );
  const duplicateTokens = Math.min(
    Math.max(0, usage.input_tokens - rebilled),
    duplicateApportioned,
  );

  return {
    prompt_tokens_total: promptTokensTotal,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_write_tokens: usage.cache_write_tokens,
    cache_read_tokens: usage.cache_read_tokens,
    repeated_prefix_tokens_apportioned: repeatedPrefix,
    repeated_rebilled_tokens_apportioned: rebilled,
    duplicate_attachment_tokens_apportioned: duplicateTokens,
    duplicate_attachment_count: input.duplicateCount,
    repeated_message_count: input.repeatedMessageCount,
    turn_index: input.turnIndex,
  };
}

// --- Store ---

export interface PromptFactsObservation {
  readonly project_hint: string;
  readonly session_key: string;
  readonly model: string | null;
  readonly occurred_at: string;
  readonly input_tokens: number;
  readonly cache_read_tokens: number;
  readonly repeated_prefix_tokens_apportioned: number;
  readonly repeated_rebilled_tokens_apportioned: number;
  readonly duplicate_attachment_tokens_apportioned: number;
  readonly duplicate_attachment_count: number;
}

export interface PromptFactsFile {
  readonly kind: typeof PROMPT_FACTS_KIND;
  readonly sessions: readonly PromptSessionState[];
  readonly observations: readonly PromptFactsObservation[];
}

export function emptyPromptFacts(): PromptFactsFile {
  return { kind: PROMPT_FACTS_KIND, sessions: [], observations: [] };
}

function finiteInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : null;
}

function parseSession(value: unknown): PromptSessionState | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  if (typeof value.session_key !== "string" || !/^[0-9a-f]{32}$/.test(value.session_key)) {
    return null;
  }
  if (typeof value.project_hint !== "string" || value.project_hint === "") {
    return null;
  }
  if (typeof value.chain_tip !== "string" || !/^[0-9a-f]{64}$/.test(value.chain_tip)) {
    return null;
  }
  const messageCount = finiteInt(value.message_count);
  const turnIndex = finiteInt(value.turn_index);
  if (messageCount === null || messageCount < 1 || turnIndex === null || turnIndex < 0) {
    return null;
  }
  if (typeof value.last_seen_at !== "string" || !Number.isFinite(Date.parse(value.last_seen_at))) {
    return null;
  }
  const attachment_hashes = Array.isArray(value.attachment_hashes)
    ? value.attachment_hashes.filter(
        (item): item is string => typeof item === "string" && /^[0-9a-f]{64}$/.test(item),
      )
    : [];
  return {
    session_key: value.session_key,
    project_hint: value.project_hint,
    chain_tip: value.chain_tip,
    message_count: messageCount,
    turn_index: turnIndex,
    attachment_hashes: attachment_hashes.slice(0, MAX_ATTACHMENT_HASHES),
    last_seen_at: value.last_seen_at,
  };
}

function parseObservation(value: unknown): PromptFactsObservation | null {
  if (!isPlainRecord(value) || typeof value.project_hint !== "string" || value.project_hint === "") {
    return null;
  }
  if (typeof value.session_key !== "string" || value.session_key === "") {
    return null;
  }
  if (typeof value.occurred_at !== "string" || !Number.isFinite(Date.parse(value.occurred_at))) {
    return null;
  }
  const input_tokens = finiteInt(value.input_tokens);
  const cache_read_tokens = finiteInt(value.cache_read_tokens);
  const repeated_prefix = finiteInt(value.repeated_prefix_tokens_apportioned);
  const repeated_rebilled = finiteInt(value.repeated_rebilled_tokens_apportioned);
  const duplicate_tokens = finiteInt(value.duplicate_attachment_tokens_apportioned);
  const duplicate_count = finiteInt(value.duplicate_attachment_count);
  if (
    input_tokens === null ||
    cache_read_tokens === null ||
    repeated_prefix === null ||
    repeated_rebilled === null ||
    duplicate_tokens === null ||
    duplicate_count === null
  ) {
    return null;
  }
  return {
    project_hint: value.project_hint,
    session_key: value.session_key,
    model: typeof value.model === "string" && value.model !== "" ? value.model : null,
    occurred_at: value.occurred_at,
    input_tokens,
    cache_read_tokens,
    repeated_prefix_tokens_apportioned: repeated_prefix,
    repeated_rebilled_tokens_apportioned: repeated_rebilled,
    duplicate_attachment_tokens_apportioned: duplicate_tokens,
    duplicate_attachment_count: duplicate_count,
  };
}

export function parsePromptFacts(value: unknown): PromptFactsFile {
  if (!isPlainRecord(value) || value.kind !== PROMPT_FACTS_KIND) {
    return emptyPromptFacts();
  }
  const sessions = Array.isArray(value.sessions)
    ? value.sessions
        .map(parseSession)
        .filter((session): session is PromptSessionState => session !== null)
    : [];
  const observations = Array.isArray(value.observations)
    ? value.observations
        .map(parseObservation)
        .filter((row): row is PromptFactsObservation => row !== null)
    : [];
  return { kind: PROMPT_FACTS_KIND, sessions, observations };
}

export function readPromptFacts(filePath: string): PromptFactsFile {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsePromptFacts(raw);
  } catch {
    return emptyPromptFacts();
  }
}

export function writePromptFacts(filePath: string, file: PromptFactsFile): void {
  ensureHelmDir();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(file, null, 2)}\n`);
}

export function defaultPromptFactsPath(): string {
  return getProxyPromptFactsPath();
}

// --- Per-request entry point ---

export interface PromptFactsResult {
  readonly file: PromptFactsFile;
  readonly session: PromptSessionState;
  readonly measurement: PromptFactsMeasurement;
}

/**
 * Chain this request onto its session, measure the repeated context, and return
 * the next store state. Callers persist `file` and upload `measurement`.
 * Returns null whenever we cannot prove anything (no messages, no provider
 * usage, an over-long conversation) — silence beats a guess.
 */
export function observePromptFacts(input: {
  file: PromptFactsFile;
  parsed: unknown;
  usage: ProviderUsage | null;
  projectHint: string;
  model: string | null;
  now: Date;
  sessionKey?: string;
  windowMs?: number;
}): PromptFactsResult | null {
  if (input.projectHint === "" || input.usage === null) {
    return null;
  }
  const chain = messageChainFromRequestBody(input.parsed);
  if (chain === null) {
    return null;
  }
  const matched = matchPromptSession({
    sessions: input.file.sessions,
    projectHint: input.projectHint,
    chain,
    now: input.now,
    ...(input.windowMs !== undefined ? { windowMs: input.windowMs } : {}),
  });

  const repeatedMessageCount = matched?.repeatedMessageCount ?? 0;
  const attachments = scanAttachments({
    parsed: input.parsed,
    repeatedMessageCount,
    seenHashes: matched?.session.attachment_hashes ?? [],
  });

  const measurement = measurePromptFacts({
    usage: input.usage,
    chain,
    repeatedMessageCount,
    duplicateCount: attachments.duplicateCount,
    duplicateBytes: attachments.duplicateBytes,
    turnIndex: (matched?.session.turn_index ?? -1) + 1,
  });
  if (measurement === null) {
    return null;
  }

  const sessionKey = matched?.session.session_key ?? input.sessionKey ?? mintPromptSessionKey();
  const chainTip = chain.tips[chain.tips.length - 1];
  if (chainTip === undefined) {
    return null;
  }
  const seen = new Set(matched?.session.attachment_hashes ?? []);
  for (const hash of attachments.allHashes) {
    seen.add(hash);
  }
  const session: PromptSessionState = {
    session_key: sessionKey,
    project_hint: input.projectHint,
    chain_tip: chainTip,
    message_count: chain.tips.length,
    turn_index: measurement.turn_index,
    attachment_hashes: [...seen].slice(-MAX_ATTACHMENT_HASHES),
    last_seen_at: input.now.toISOString(),
  };

  const observation: PromptFactsObservation = {
    project_hint: input.projectHint,
    session_key: sessionKey,
    model: input.model !== null && input.model !== "unknown" ? input.model : null,
    occurred_at: input.now.toISOString(),
    input_tokens: measurement.input_tokens,
    cache_read_tokens: measurement.cache_read_tokens,
    repeated_prefix_tokens_apportioned: measurement.repeated_prefix_tokens_apportioned,
    repeated_rebilled_tokens_apportioned: measurement.repeated_rebilled_tokens_apportioned,
    duplicate_attachment_tokens_apportioned:
      measurement.duplicate_attachment_tokens_apportioned,
    duplicate_attachment_count: measurement.duplicate_attachment_count,
  };

  const sessions = [
    session,
    ...input.file.sessions.filter((existing) => existing.session_key !== sessionKey),
  ].slice(0, MAX_SESSIONS);

  return {
    file: {
      kind: PROMPT_FACTS_KIND,
      sessions,
      observations: [observation, ...input.file.observations].slice(0, MAX_OBSERVATIONS),
    },
    session,
    measurement,
  };
}

// --- Local window summary ---

export interface PromptFactsSummary {
  /** Requests observed at the wrap in this window. */
  readonly observations: number;
  /** Requests that re-sent context and were re-billed for it. */
  readonly duplicate_prompt_count: number;
  readonly repeated_rebilled_tokens: number;
  readonly duplicate_attachment_tokens: number;
  readonly duplicate_attachment_count: number;
}

/**
 * Roll the stored observations into a window summary for `helm scan` and
 * `helm audit`. Tokens only. Pricing these tokens is Helm Web's job, so this
 * summary deliberately carries no dollar figure.
 */
export function summarizePromptFacts(
  file: PromptFactsFile,
  input: { now: Date; windowDays: number },
): PromptFactsSummary | null {
  const cutoff = input.now.getTime() - input.windowDays * 24 * 60 * 60 * 1000;
  let observations = 0;
  let duplicatePrompts = 0;
  let rebilled = 0;
  let duplicateTokens = 0;
  let duplicateAttachments = 0;
  for (const row of file.observations) {
    const then = Date.parse(row.occurred_at);
    if (!Number.isFinite(then) || then < cutoff) {
      continue;
    }
    observations += 1;
    rebilled += row.repeated_rebilled_tokens_apportioned;
    duplicateTokens += row.duplicate_attachment_tokens_apportioned;
    duplicateAttachments += row.duplicate_attachment_count;
    if (row.repeated_rebilled_tokens_apportioned > 0) {
      duplicatePrompts += 1;
    }
  }
  if (observations === 0) {
    return null;
  }
  return {
    observations,
    duplicate_prompt_count: duplicatePrompts,
    repeated_rebilled_tokens: rebilled,
    duplicate_attachment_tokens: duplicateTokens,
    duplicate_attachment_count: duplicateAttachments,
  };
}
