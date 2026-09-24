/**
 * Ruff and flake8 diagnostics.
 *
 * Both print `path:line:col: CODE message` rows, where the uppercase rule code
 * is the finding's identity. Ruff additionally prints `Found N errors.` and
 * `[*] N fixable`; flake8 output has neither, so it is only trusted when at
 * least two code-shaped rows are present (a single short row never reaches the
 * registry anyway, and arbitrary prose does not produce two such rows).
 */

import type { ToolOutputDetector, ToolSummary } from "../types.js";
import { buildDiagnosticSummary, type DiagnosticItem } from "../diagnostics.js";
import { lines, parseIntOr } from "../helpers.js";

const DIAGNOSTIC = /^(.*?):(\d+):(\d+):\s+([A-Za-z]{1,5}\d{1,4})\s+(.*)$/;
const FOUND = /Found\s+(\d+)\s+errors?\b/;
const RUFF_HINT = /\bRuff\b|\[\*\]\s+\d+\s+fixable|\bruff\b/i;
const FLAKE8_HINT = /\bflake8\b/i;

export const ruff: ToolOutputDetector = {
  id: "ruff",
  summarize(text: string): ToolSummary | null {
    const items: DiagnosticItem[] = [];
    for (const raw of lines(text)) {
      const match = DIAGNOSTIC.exec(raw.trim());
      if (!match) {
        continue;
      }
      items.push({
        file: (match[1] ?? "").trim(),
        line: parseIntOr(match[2]),
        col: parseIntOr(match[3]),
        code: match[4] ?? "",
        message: (match[5] ?? "").trim(),
      });
    }
    const trusted = FOUND.test(text) || RUFF_HINT.test(text) || items.length >= 2;
    if (!trusted || items.length === 0) {
      return null;
    }
    const warnings = items.filter((item) => /^W\d/i.test(item.code ?? "")).length;
    const found = FOUND.exec(text);
    const errors = found
      ? Math.max(0, parseIntOr(found[1]) - warnings)
      : items.length - warnings;
    const tool = RUFF_HINT.test(text) ? "ruff" : FLAKE8_HINT.test(text) ? "flake8" : "ruff";
    return buildDiagnosticSummary({ tool, errors, warnings, items });
  },
};
