/**
 * Shared contracts and builder for compiler/linter diagnostics.
 *
 * Unlike test summaries, diagnostics are reported at `file:line` granularity.
 * The compact summary keeps every finding's identity (file, line, column, code,
 * message) so the proxy never hides *which* error appeared — only how many
 * lines it occupied. Identical findings are deduped and the item array is
 * capped, but individual messages are never truncated.
 */

import type { ToolSummary } from "./types.js";
import { safeJson } from "./helpers.js";

export interface DiagnosticItem {
  file: string;
  line: number;
  col?: number;
  code?: string;
  message: string;
}

export interface DiagnosticSummaryInput {
  readonly tool: string;
  readonly errors?: number;
  readonly warnings?: number;
  readonly items?: readonly DiagnosticItem[];
}

/** Hard cap on retained diagnostic identities; extras become a counter. */
export const MAX_DIAGNOSTICS = 25;

function itemKey(item: DiagnosticItem): string {
  return `${item.file}|${item.line}|${item.col ?? ""}|${item.code ?? ""}|${item.message}`;
}

/**
 * Build the canonical compact diagnostic summary. Zero counts and empty item
 * lists are omitted, so a clean run stays tiny and a failing run is bounded by
 * `MAX_DIAGNOSTICS` rather than by the size of the raw output.
 */
export function buildDiagnosticSummary(input: DiagnosticSummaryInput): ToolSummary {
  const seen = new Set<string>();
  const items: DiagnosticItem[] = [];
  for (const item of input.items ?? []) {
    const file = (item.file ?? "").trim();
    const message = item.message ?? "";
    if (file === "" && message.trim() === "") {
      continue;
    }
    const normalized: DiagnosticItem = {
      file,
      line: Number.isFinite(item.line) ? Math.max(0, Math.trunc(item.line)) : 0,
      message,
    };
    if (typeof item.col === "number" && Number.isFinite(item.col)) {
      normalized.col = Math.trunc(item.col);
    }
    if (typeof item.code === "string" && item.code.trim() !== "") {
      normalized.code = item.code.trim();
    }
    const key = itemKey(normalized);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push(normalized);
  }

  const errors = Math.max(0, Math.trunc(input.errors ?? 0));
  const warnings = Math.max(0, Math.trunc(input.warnings ?? 0));

  const out: Record<string, unknown> = { tool: input.tool };
  if (errors > 0) {
    out.errors = errors;
  }
  if (warnings > 0) {
    out.warnings = warnings;
  }
  if (items.length > 0) {
    out.items = items.slice(0, MAX_DIAGNOSTICS);
    if (items.length > MAX_DIAGNOSTICS) {
      out.items_truncated = items.length - MAX_DIAGNOSTICS;
    }
  }
  return { tool: input.tool, text: safeJson(out) };
}

export interface FileLineCol {
  readonly file: string;
  readonly line: number;
  readonly col?: number;
}

/**
 * Parse a leading `path:line` or `path:line:col` from a diagnostic line. Returns
 * null when the prefix is not file-location shaped. Paths may contain a Windows
 * drive letter; only the first `:digits` occurrence is treated as the line.
 */
export function parseFileLineCol(line: string): FileLineCol | null {
  const match = /^(.+?):(\d+)(?::(\d+))?(?=\D|$)/.exec(line.trim());
  if (!match) {
    return null;
  }
  const file = (match[1] ?? "").trim();
  if (file === "") {
    return null;
  }
  const lineNo = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(lineNo)) {
    return null;
  }
  const result: { file: string; line: number; col?: number } = { file, line: lineNo };
  if (match[3] !== undefined) {
    const col = Number.parseInt(match[3], 10);
    if (Number.isFinite(col)) {
      result.col = col;
    }
  }
  return result;
}
