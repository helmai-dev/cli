/**
 * Shared, pure helpers for tool-output detectors.
 *
 * Detectors run inside the local proxy on the newest message only, so every
 * helper here is synchronous, allocation-light, and must never throw on
 * arbitrary input. A detector that is unsure returns null; wrongly compressing
 * arbitrary prose is worse than not compressing at all.
 */

import type { ToolSummary } from "./types.js";

const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;

/** Remove ANSI CSI escape sequences (colors, cursor moves) from text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** Split ANSI-stripped text into lines, tolerating CRLF. */
export function lines(text: string): string[] {
  return stripAnsi(text).split(/\r?\n/);
}

/** Count non-overlapping matches of `pattern` in `text` (adds the g flag). */
export function countMatches(text: string, pattern: RegExp): number {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  let count = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    count += 1;
    if (match.index === re.lastIndex) {
      re.lastIndex += 1;
    }
  }
  return count;
}

/** Parse a possibly-formatted numeric token ("1,234", "1.5"); null if absent. */
export function parseNumber(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const cleaned = raw.replace(/[,_\s]/g, "");
  if (cleaned === "") {
    return null;
  }
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** Parse a numeric token, falling back when the token is absent/invalid. */
export function parseIntOr(raw: string | null | undefined, fallback = 0): number {
  const value = parseNumber(raw);
  return value === null ? fallback : Math.trunc(value);
}

/**
 * Parse a duration into milliseconds. Handles "1.2s", "120ms", "2m", "1h",
 * "00:01.234" and bare seconds. Returns null when nothing parses.
 */
export function parseDurationMs(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const value = raw.trim();
  if (value === "") {
    return null;
  }
  const colon = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(value);
  if (colon) {
    const hours = parseIntOr(colon[1], 0);
    const minutes = parseIntOr(colon[2], 0);
    const seconds = parseIntOr(colon[3], 0);
    const fraction = colon[4] ? Number(`0.${colon[4]}`) : 0;
    return Math.round(((hours * 60 + minutes) * 60 + seconds + fraction) * 1000);
  }
  const unit = /([\d.,]+)\s*(ms|milliseconds?|s|sec(?:onds?)?|m|min(?:utes?)?|h|hours?)/i.exec(
    value,
  );
  if (unit) {
    const amount = parseNumber(unit[1]);
    if (amount === null) {
      return null;
    }
    const suffix = (unit[2] ?? "").toLowerCase();
    if (suffix.startsWith("ms") || suffix.startsWith("milli")) {
      return Math.round(amount);
    }
    if (suffix.startsWith("h")) {
      return Math.round(amount * 3_600_000);
    }
    if (suffix.startsWith("m")) {
      return Math.round(amount * 60_000);
    }
    return Math.round(amount * 1000);
  }
  const bare = parseNumber(value);
  return bare === null ? null : Math.round(bare * 1000);
}

/** JSON.stringify that never throws and always yields a string. */
export function safeJson(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? json : "{}";
  } catch {
    return "{}";
  }
}

/**
 * Build one compact failure line: the test identity, its message, and a
 * verbatim `file:line` when one was found. Duplicated locations are dropped.
 */
export function formatFailure(name: string, message?: string, location?: string): string {
  const cleanName = (name ?? "").trim();
  const parts = [cleanName];
  const detail = (message ?? "").trim();
  if (detail !== "") {
    parts.push(detail);
  }
  const loc = (location ?? "").trim();
  if (loc !== "" && !detail.includes(loc) && !cleanName.includes(loc)) {
    parts.push(loc);
  }
  return parts.join(" — ");
}

export interface TestSummaryInput {
  readonly tool: string;
  readonly passed?: number;
  readonly failed?: number;
  readonly skipped?: number;
  readonly durationMs?: number;
  readonly failures?: readonly string[];
}

/** Hard cap on retained failure identities; extras become a counter. */
export const MAX_FAILURES = 20;

/**
 * Build the canonical compact summary. Empty optional fields are omitted, so a
 * passing run and a huge failing run stay roughly the same size regardless of
 * how many tests ran.
 */
export function buildTestSummary(input: TestSummaryInput): ToolSummary {
  const passed = Math.max(0, Math.trunc(input.passed ?? 0));
  const failed = Math.max(0, Math.trunc(input.failed ?? 0));
  const skipped = Math.max(0, Math.trunc(input.skipped ?? 0));
  const failures = (input.failures ?? []).filter((line) => line.trim() !== "");
  const out: Record<string, unknown> = {
    tool: input.tool,
    result: failed > 0 ? "failed" : "passed",
  };
  const tests = passed + failed;
  if (tests > 0) {
    out.tests = tests;
  }
  if (passed > 0) {
    out.passed = passed;
  }
  if (failed > 0) {
    out.failed = failed;
  }
  if (skipped > 0) {
    out.skipped = skipped;
  }
  if (
    typeof input.durationMs === "number" &&
    Number.isFinite(input.durationMs) &&
    input.durationMs > 0
  ) {
    out.duration_ms = Math.round(input.durationMs);
  }
  if (failures.length > 0) {
    out.failures = failures.slice(0, MAX_FAILURES);
    if (failures.length > MAX_FAILURES) {
      out.failures_truncated = failures.length - MAX_FAILURES;
    }
  }
  return { tool: input.tool, text: safeJson(out) };
}

export interface GenericSummaryInput {
  readonly tool: string;
  readonly result?: string;
  readonly counts?: Readonly<Record<string, number>>;
  /** Verbatim error identities; never truncated in place, only capped. */
  readonly errors?: readonly string[];
  /** Verbatim warning/deprecation identities, e.g. npm deprecations. */
  readonly warnings?: readonly string[];
}

/** Hard cap on retained verbatim lines per generic list; extras become a counter. */
export const MAX_LIST_ITEMS = 25;

/**
 * Build a compact summary for build/operation output that is neither a test run
 * nor a compiler diagnostic: docker builds, terraform plans/applies, and
 * package-manager installs. Numeric counts and verbatim error/warning lines are
 * preserved (errors are never rewritten), while zero counts are omitted so a
 * clean run stays small. Each list is capped like the other summaries.
 */
export function buildGenericSummary(input: GenericSummaryInput): ToolSummary {
  const out: Record<string, unknown> = { tool: input.tool };
  const result = (input.result ?? "").trim();
  if (result !== "") {
    out.result = result;
  }
  for (const [key, value] of Object.entries(input.counts ?? {})) {
    if (!Number.isFinite(value) || value <= 0) {
      continue;
    }
    out[key] = Math.trunc(value);
  }
  const lists: Array<[string, readonly string[] | undefined]> = [
    ["errors", input.errors],
    ["warnings", input.warnings],
  ];
  for (const [key, values] of lists) {
    const items = (values ?? []).filter((line) => line.trim() !== "");
    if (items.length === 0) {
      continue;
    }
    out[key] = items.slice(0, MAX_LIST_ITEMS);
    if (items.length > MAX_LIST_ITEMS) {
      out[`${key}_truncated`] = items.length - MAX_LIST_ITEMS;
    }
  }
  return { tool: input.tool, text: safeJson(out) };
}
