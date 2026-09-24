/**
 * Local, content-aware compression for proxied requests (Stage 2).
 *
 * Levels, all applied ONLY to the newest message so the frozen prefix
 * (provider cache) is never rewritten:
 * - JSON is minified losslessly; when aggressive mode is on, large homogeneous
 *   arrays are structurally crushed (first/last kept, the middle replaced by a
 *   marker naming a reversible-store key).
 * - Logs/text get terminal escapes stripped, trailing whitespace trimmed,
 *   blank-line runs squeezed, and long runs of identical lines collapsed with a
 *   marker that names the reversible key.
 *
 * A net-reduction guard means compression can never make a request bigger.
 * Saved-token counts are exact for OpenAI-family models (BPE tokenizer) and a
 * labeled bytes/4 estimate elsewhere. It is fail-open.
 */

import { createHash } from "node:crypto";
import { countTextTokens } from "./tokenizer.js";
import { summarizeToolOutput } from "./tool-output/registry.js";

export { estimateTokens } from "./tokenizer.js";

export interface OriginalBlock {
  readonly key: string;
  readonly text: string;
}

export interface TextCompression {
  readonly text: string;
  readonly beforeBytes: number;
  readonly afterBytes: number;
  readonly savedTokens: number;
  readonly tokensExact: boolean;
  /** sha256 of the original when the text changed; null when untouched. */
  readonly originalKey: string | null;
}

export interface BodyCompression {
  readonly body: Record<string, unknown>;
  readonly savedBytes: number;
  readonly savedTokens: number;
  readonly tokensExact: boolean;
  readonly originals: readonly OriginalBlock[];
}

export interface CompressOptions {
  /** Enable lossy structural crush of large homogeneous JSON arrays. */
  readonly aggressive?: boolean;
  /** Model id, used to pick an exact tokenizer when one is available. */
  readonly model?: string;
  /** Measured tokens-per-byte fallback for models without a tokenizer. */
  readonly tokensPerByte?: number;
}

const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;
const REPEAT_THRESHOLD = 4;
const REF_CHARS = 12;
const CRUSH_MIN_ARRAY = 12;
const CRUSH_KEEP_HEAD = 3;
const CRUSH_KEEP_TAIL = 3;
const CRUSH_MARKER_KEY = "__helm_crushed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function keyOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Minify a JSON document losslessly; null when the text is not JSON or shrinks. */
function tryMinifyJson(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return null;
  }
  try {
    const minified = JSON.stringify(JSON.parse(trimmed) as unknown);
    if (typeof minified !== "string") {
      return null;
    }
    return minified.length < text.length ? minified : null;
  } catch {
    return null;
  }
}

function sameKeys(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) {
    return false;
  }
  return keys.every((key) => Object.prototype.hasOwnProperty.call(b, key));
}

function homogeneous(items: readonly Record<string, unknown>[]): boolean {
  const first = items[0];
  return first !== undefined && items.every((item) => sameKeys(first, item));
}

function crushValue(value: unknown, ref: string): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const result = crushValue(item, ref);
      changed = changed || result.changed;
      return result.value;
    });
    if (
      items.length >= CRUSH_MIN_ARRAY &&
      items.every((item): item is Record<string, unknown> => isRecord(item)) &&
      homogeneous(items)
    ) {
      const head = items.slice(0, CRUSH_KEEP_HEAD);
      const tail = items.slice(items.length - CRUSH_KEEP_TAIL);
      const omitted = items.length - head.length - tail.length;
      if (omitted > 0) {
        return {
          value: [...head, { [CRUSH_MARKER_KEY]: omitted, helm_ref: ref }, ...tail],
          changed: true,
        };
      }
    }
    return { value: changed ? items : value, changed };
  }
  if (isRecord(value)) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const result = crushValue(entry, ref);
      changed = changed || result.changed;
      out[key] = result.value;
    }
    return { value: changed ? out : value, changed };
  }
  return { value, changed: false };
}

/** Structural crush of large homogeneous arrays; null when it does not shrink. */
export function crushJson(text: string, ref: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const { value, changed } = crushValue(parsed, ref);
  if (!changed) {
    return null;
  }
  const out = JSON.stringify(value);
  return out !== null && out.length < text.length ? out : null;
}

/** Replace a run of N>=threshold identical non-blank lines with one + a marker. */
export function collapseRepeatedLines(text: string, threshold = REPEAT_THRESHOLD, ref = ""): string {
  const lines = text.split("\n");
  const out: string[] = [];
  const suffix = ref === "" ? "" : ` helm:${ref}`;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    let end = index + 1;
    while (end < lines.length && lines[end] === line) {
      end += 1;
    }
    const count = end - index;
    if (line.trim() !== "" && count >= threshold) {
      out.push(`${line} [... x${count}${suffix}]`);
    } else {
      for (let cursor = index; cursor < end; cursor += 1) {
        out.push(line);
      }
    }
    index = end;
  }
  return out.join("\n");
}

export function compressText(input: string, options: CompressOptions = {}): TextCompression {
  const beforeBytes = byteLength(input);
  const originalKey = keyOf(input);
  const ref = originalKey.slice(0, REF_CHARS);
  let text = input.replace(ANSI_RE, "");
  // Tool-output step: recognized test-runner output collapses to a compact
  // constant-size JSON summary. This is lossy, so `originalKey` still records
  // the sha256 of the original and the reversible store can replay it. The
  // summary is only used when it is strictly smaller, and it deliberately wins
  // over the generic JSON/text transforms below. Fail-open: no match => null.
  const toolSummary = summarizeToolOutput(text);
  if (toolSummary !== null && toolSummary.text.length < text.length) {
    text = toolSummary.text;
  } else {
    const minified = tryMinifyJson(text);
    if (minified !== null) {
      text = minified;
      if (options.aggressive) {
        const crushed = crushJson(minified, ref);
        if (crushed !== null) {
          text = crushed;
        }
      }
    } else {
      text = collapseRepeatedLines(text, REPEAT_THRESHOLD, ref);
      text = text.replace(/[ \t]+$/gm, "");
      text = text.replace(/\n{3,}/g, "\n\n");
    }
  }
  const afterBytes = byteLength(text);
  // Never inflate a request: if the transforms did not shrink it, leave it be.
  if (afterBytes >= beforeBytes) {
    return {
      text: input,
      beforeBytes,
      afterBytes: beforeBytes,
      savedTokens: 0,
      tokensExact: false,
      originalKey: null,
    };
  }
  const before = countTextTokens(input, options.model, options.tokensPerByte);
  const after = countTextTokens(text, options.model, options.tokensPerByte);
  return {
    text,
    beforeBytes,
    afterBytes,
    savedTokens: Math.max(0, before.tokens - after.tokens),
    tokensExact: before.exact && after.exact,
    originalKey: text !== input ? originalKey : null,
  };
}

interface ContentCompression {
  content: unknown;
  saved: number;
  savedTokens: number;
  tokensExact: boolean;
  originals: OriginalBlock[];
}

function compressContent(content: unknown, options: CompressOptions): ContentCompression {
  if (typeof content === "string") {
    const result = compressText(content, options);
    return {
      content: result.text,
      saved: result.beforeBytes - result.afterBytes,
      savedTokens: result.savedTokens,
      tokensExact: result.tokensExact,
      originals: result.originalKey ? [{ key: result.originalKey, text: content }] : [],
    };
  }
  if (!Array.isArray(content)) {
    return { content, saved: 0, savedTokens: 0, tokensExact: true, originals: [] };
  }
  let saved = 0;
  let savedTokens = 0;
  let tokensExact = true;
  const originals: OriginalBlock[] = [];
  const next = content.map((part) => {
    if (!isRecord(part)) {
      return part;
    }
    if (typeof part.text === "string") {
      const result = compressText(part.text, options);
      saved += result.beforeBytes - result.afterBytes;
      savedTokens += result.savedTokens;
      tokensExact = tokensExact && (result.savedTokens === 0 || result.tokensExact);
      if (result.originalKey) {
        originals.push({ key: result.originalKey, text: part.text });
      }
      return { ...part, text: result.text };
    }
    if (part.type === "tool_result" && part.content !== undefined) {
      const inner = compressContent(part.content, options);
      saved += inner.saved;
      savedTokens += inner.savedTokens;
      tokensExact = tokensExact && inner.tokensExact;
      originals.push(...inner.originals);
      return { ...part, content: inner.content };
    }
    return part;
  });
  return { content: next, saved, savedTokens, tokensExact, originals };
}

/**
 * Compress only the newest message of a body. Returns the original body with
 * savedBytes 0 when there is nothing to do, so callers can skip the rewrite.
 */
export function compressLastMessage(body: unknown, options: CompressOptions = {}): BodyCompression {
  if (!isRecord(body) || !Array.isArray(body.messages) || body.messages.length === 0) {
    return {
      body: isRecord(body) ? body : {},
      savedBytes: 0,
      savedTokens: 0,
      tokensExact: false,
      originals: [],
    };
  }
  const lastIndex = body.messages.length - 1;
  const last = body.messages[lastIndex];
  if (!isRecord(last)) {
    return { body, savedBytes: 0, savedTokens: 0, tokensExact: false, originals: [] };
  }
  const { content, saved, savedTokens, tokensExact, originals } = compressContent(
    last.content,
    options,
  );
  if (saved <= 0) {
    return { body, savedBytes: 0, savedTokens: 0, tokensExact: false, originals: [] };
  }
  const messages = [...body.messages];
  messages[lastIndex] = { ...last, content };
  return {
    body: { ...body, messages },
    savedBytes: saved,
    savedTokens,
    tokensExact,
    originals,
  };
}
